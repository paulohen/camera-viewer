# Analisa a câmera RTSP: detecta movimento, objetos (YOLO) e rostos conhecidos (YuNet + SFace)
# e salva uma foto anotada + JSON em OUTPUT_DIR/dd-mm-yyyy/.
# Só roda a análise pesada quando há movimento.

import glob
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta

import cv2
import numpy as np
from ultralytics import YOLO

import retention
from alerts import Health, UnknownAlerts
from garage import VEHICLE_CLASSES, GarageMonitor
from gate import GateMonitor

CONFIG = json.load(open(os.environ.get('CONFIG_PATH', '/app/config.json')))
# Por padrão analisa o stream principal da câmera (subtype=0, 1080p): o sub-stream deixa o rosto pequeno demais.
RTSP = (os.environ.get('ANALYZER_RTSP_URL') or CONFIG.get('analyzerRtspUrl')
        or CONFIG['rtspUrl'].replace('subtype=1', 'subtype=0'))
OUT_DIR = os.environ.get('OUTPUT_DIR', '/data')
GATE_DIR = os.environ.get('GATE_DIR', '/app/gate')
FACES_DIR = os.environ.get('FACES_DIR', '/app/faces')
CAND_DIR = os.environ.get('CANDIDATES_DIR', '/app/faces_candidates')  # recortes para revisão; NÃO entram no reconhecimento
MODELS = '/opt/models'

ANALYZE_FPS = float(os.environ.get('ANALYZE_FPS', 8))
MOTION_MIN_AREA = float(os.environ.get('MOTION_MIN_AREA', 0.005))  # fração do quadro em movimento
MOTION_HOLD = float(os.environ.get('MOTION_HOLD', 4))              # segundos analisando após o último movimento
COOLDOWN = float(os.environ.get('COOLDOWN', 6))                    # s sem salvar o mesmo rótulo de novo
TRACK_TTL = float(os.environ.get('TRACK_TTL', 3))                  # s sem ver o objeto para considerar que saiu
UNKNOWN_AFTER = float(os.environ.get('UNKNOWN_AFTER', 10))         # s em cena sem reconhecer -> salva como desconhecida
CAND_PER_TRACK = int(os.environ.get('CAND_PER_TRACK', 3))          # recortes guardados por passagem
CAND_MAX = int(os.environ.get('CAND_MAX', 30))                     # máximo pendente por pessoa
CAND_MIN_FACE = int(os.environ.get('CAND_MIN_FACE', 60))           # largura mínima (px) do rosto candidato
CAND_DEDUP = float(os.environ.get('CAND_DEDUP', 0.75))             # similaridade acima disso = quase repetido
MIN_FACE = int(os.environ.get('MIN_FACE', 40))                     # largura mínima (px) de rosto usado p/ identificar
CONF = float(os.environ.get('OBJECT_CONF', 0.40))
SOLO_CONF = float(os.environ.get('SOLO_CONF', 0.60))               # uma única detecção basta se for tão confiante
SEQ_EVERY = float(os.environ.get('SEQ_EVERY', 1.5))                # foto de acompanhamento a cada tanto enquanto a pessoa está em cena
SEQ_MAX = int(os.environ.get('SEQ_MAX', 4))                        # máximo de fotos de acompanhamento por passagem (0 desliga)
FACE_DETECT_WIDTH = int(os.environ.get('FACE_DETECT_WIDTH', 960))  # rostos são procurados nessa largura (1080p inteiro é 4x mais lento)
FACE_THRESHOLD = float(os.environ.get('FACE_THRESHOLD', 0.363))    # limiar de cosseno recomendado p/ SFace

# classe COCO -> rótulo (ASCII, porque o OpenCV não desenha acentos)
CLASSES = {0: 'pessoa', 1: 'bicicleta', 2: 'carro', 3: 'moto', 5: 'onibus', 7: 'caminhao', 15: 'gato', 16: 'cachorro'}


def log(*a):
    print(datetime.now().strftime('%H:%M:%S'), *a, flush=True)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'x'


class Grabber(threading.Thread):
    """Lê o RTSP continuamente e guarda só o último quadro (evita atraso acumulado)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.frame = None
        self.seq = 0

    def run(self):
        while True:
            # sem isso, um stream travado só é percebido após 30 s; com limites curtos a recuperação leva ~8-10 s
            cap = cv2.VideoCapture(RTSP, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000])
            if not cap.isOpened():
                log('sem conexão com a câmera, tentando de novo em 5 s')
                time.sleep(5)
                continue
            log('conectado à câmera')
            while True:
                ok, f = cap.read()
                if not ok:
                    break
                with self.lock:
                    self.frame, self.seq = f, self.seq + 1
            cap.release()
            log('stream caiu, reconectando')
            time.sleep(3)

    def latest(self, last_seq):
        with self.lock:
            if self.frame is None or self.seq == last_seq:
                return None, last_seq
            return self.frame.copy(), self.seq


class Faces:
    def __init__(self):
        self.det = cv2.FaceDetectorYN.create(f'{MODELS}/yunet.onnx', '', (320, 320), 0.7, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(f'{MODELS}/sface.onnx', '')
        self.known = {}  # nome -> [embeddings]  (faces/)
        self.cand = {}   # nome -> [embeddings]  (faces_candidates/, só p/ evitar repetidos)
        self.sig = None
        self.cache = {}  # (arquivo, mtime) -> embedding | None

    def detect(self, img):
        """Detecta rostos numa cópia reduzida (rápido) e devolve as coordenadas na escala da imagem original."""
        h, w = img.shape[:2]
        scale = FACE_DETECT_WIDTH / w if w > FACE_DETECT_WIDTH else 1.0
        small = cv2.resize(img, (FACE_DETECT_WIDTH, int(h * scale)), interpolation=cv2.INTER_AREA) if scale != 1.0 else img
        self.det.setInputSize((small.shape[1], small.shape[0]))
        _, faces = self.det.detect(small)
        if faces is None:
            return []
        if scale != 1.0:
            faces = faces.copy()
            faces[:, :14] /= scale  # caixa (4) + 5 pontos (10); a coluna 14 é a confiança
        return faces

    def embed(self, img, face):
        return self.rec.feature(self.rec.alignCrop(img, face))

    def _scan(self, root, warn):
        out, status = {}, {}
        for f in sorted(glob.glob(f'{root}/*/*.*')):
            key = (f, os.path.getmtime(f))
            if key not in self.cache:
                emb, is_image = None, False
                img = cv2.imread(f)
                if img is not None:
                    is_image = True
                    faces = self.detect(img)
                    if len(faces):
                        emb = self.embed(img, max(faces, key=lambda r: r[2] * r[3]))
                    elif warn:
                        log(f'aviso: nenhum rosto em {f}')
                self.cache[key] = (is_image, emb)
            is_image, emb = self.cache[key]
            if is_image:
                status[os.path.relpath(f, root)] = emb is not None
            if emb is not None:
                out.setdefault(slug(os.path.basename(os.path.dirname(f))), []).append(emb)
        return out, status

    def load(self):
        sig = [(f, os.path.getmtime(f)) for root in (FACES_DIR, CAND_DIR) for f in sorted(glob.glob(f'{root}/*/*.*'))]
        if sig == self.sig:
            return
        self.sig = sig
        known, status = self._scan(FACES_DIR, True)
        if {k: len(v) for k, v in known.items()} != {k: len(v) for k, v in self.known.items()}:
            log('rostos cadastrados:', {k: len(v) for k, v in known.items()} or 'nenhum')
        self.known = known
        self.cand, _ = self._scan(CAND_DIR, False)
        try:  # a página mostra um aviso nas fotos em que não foi achado rosto
            tmp = os.path.join(GATE_DIR, 'faces_status.json.tmp')
            json.dump(status, open(tmp, 'w'), ensure_ascii=False)
            os.replace(tmp, os.path.join(GATE_DIR, 'faces_status.json'))
        except OSError as e:
            log('não foi possível gravar faces_status.json:', e)
        self.cache = {k: v for k, v in self.cache.items() if k in set(sig)}

    def identify(self, emb):
        best, best_score = None, FACE_THRESHOLD
        for name, embs in self.known.items():
            for e in embs:
                s = self.rec.match(emb, e, cv2.FaceRecognizerSF_FR_COSINE)
                if s >= best_score:
                    best, best_score = name, s
        return best, best_score

    def similarity(self, emb, name):
        """Maior similaridade com o que já existe (cadastrado ou candidato) para esse nome."""
        embs = self.known.get(name, []) + self.cand.get(name, [])
        return max((self.rec.match(emb, e, cv2.FaceRecognizerSF_FR_COSINE) for e in embs), default=0.0)


class Track:
    """Um objeto seguido pelo YOLO entre quadros. Para pessoas, acumula 'votos' de identidade."""

    def __init__(self, tid, label, now):
        self.id, self.label, self.first, self.last = tid, label, now, now
        self.hits = 0
        self.box = None
        self.votes = {}        # nome -> [scores de rostos bons]
        self.faces_seen = 0    # rostos bons avaliados (inteiros e grandes o bastante)
        self.saved_label = None
        self.best_key = (-1,)
        self.best = None       # melhor quadro: {'frame', 'box', 'face', 'conf'}
        self.crops = []        # melhores recortes de rosto (limpos) p/ faces_candidates
        self.max_conf = 0.0
        self.moved = False     # objetos que não são pessoa só valem se a PRÓPRIA caixa se deslocou (carro parado não vira foto)
        self.first_box = None
        self.cur_face = None   # rosto visto neste quadro: (caixa, confiança)
        self.seq_saved, self.last_seq_at, self.photos = 0, 0.0, 0

    @property
    def valid(self):
        """Passagem real: 2+ detecções, ou uma só bem confiante. Objetos parados não contam."""
        return (self.hits >= 2 or self.max_conf >= SOLO_CONF) and (self.label == 'pessoa' or self.moved)

    def identity(self):
        """Nome confirmado: 2+ votos do mesmo nome, ou um voto bem forte (>= 0.5)."""
        ok = {n: v for n, v in self.votes.items() if len(v) >= 2 or max(v) >= 0.5}
        return max(ok, key=lambda n: sum(ok[n])) if ok else None

    def add_crop(self, frame, f, emb, guess):
        """Guarda o recorte do rosto se for de frente, nítido e grande; mantém só os 6 melhores."""
        h, w = frame.shape[:2]
        x, y, fw, fh = [int(v) for v in f[:4]]
        if fw < CAND_MIN_FACE:
            return
        re_, le, nose = f[4:6], f[6:8], f[8:10]  # olho direito, olho esquerdo, nariz
        eyes = max(1.0, float(np.hypot(*(re_ - le))))
        yaw = abs(float(nose[0] - (re_[0] + le[0]) / 2)) / eyes  # 0 = de frente
        if yaw > 0.35:
            return
        pw, ph = int(fw * 0.8), int(fh * 0.8)
        crop = frame[max(0, y - ph):min(h, y + fh + ph), max(0, x - pw):min(w, x + fw + pw)]
        face_gray = cv2.cvtColor(frame[max(0, y):y + fh, max(0, x):x + fw], cv2.COLOR_BGR2GRAY)
        sharp = float(cv2.Laplacian(face_gray, cv2.CV_64F).var())
        if sharp < 15:
            return
        q = min(fw, 160) / 160 * min(sharp, 150) / 150 * (1 - yaw)
        self.crops.append({'q': q, 'img': crop.copy(), 'emb': emb, 'guess': guess})
        self.crops = sorted(self.crops, key=lambda c: -c['q'])[:6]

    def offer(self, key, frame, face, conf):
        if key > self.best_key:
            self.best_key, self.best = key, {'frame': frame.copy(), 'box': self.box, 'face': face, 'conf': conf}


def save_track(tr, label, shot=None, final=True):
    """Grava foto + JSON. `shot` é o quadro a gravar (padrão: o melhor da passagem). Fotos de acompanhamento (final=False)
    não contam como a foto final da passagem."""
    now = datetime.now()
    day_dir = os.path.join(OUT_DIR, now.strftime('%d-%m-%Y'))
    os.makedirs(day_dir, exist_ok=True)
    while os.path.exists(os.path.join(day_dir, f"{now.strftime('%H-%M-%S')}_{label}.jpg")):
        now += timedelta(seconds=1)  # duas fotos no mesmo segundo com o mesmo rótulo não podem se sobrescrever
    base = os.path.join(day_dir, f"{now.strftime('%H-%M-%S')}_{label}")
    best = shot or tr.best
    img = best['frame'].copy()
    dets = [{'label': tr.label, 'conf': best['conf'], 'box': best['box']}]
    if best['face']:
        dets.append({'label': label, 'conf': best['face'][1], 'box': best['face'][0], 'face': True})
    for d in dets:
        x1, y1, x2, y2 = d['box']
        color = (0, 200, 0) if d.get('face') else (255, 140, 0)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(img, f"{d['label']} {d['conf']}", (x1, max(15, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    cv2.imwrite(base + '.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    json.dump({'time': now.isoformat(timespec='seconds'), 'label': label, 'track': tr.id, 'acompanhamento': not final,
               'segundos_em_cena': round(tr.last - tr.first, 1), 'rostos_avaliados': tr.faces_seen,
               'votos': {n: [round(x, 2) for x in v] for n, v in tr.votes.items()}, 'detections': dets},
              open(base + '.json', 'w'), ensure_ascii=False, indent=1)
    log('salvo:', os.path.basename(base), '' if final else '(acompanhamento)')
    tr.photos += 1
    if final:
        tr.saved_label = label
    return base + '.jpg'


def collect_candidates(tr, faces):
    """Ao fim da passagem, guarda até CAND_PER_TRACK recortes bons e variados em faces_candidates/<nome>/."""
    if tr.label != 'pessoa' or not tr.crops:
        return
    ident = tr.identity()
    name = ident or 'desconhecida'
    folder = os.path.join(CAND_DIR, ident or '_desconhecida')
    # recortes que o reconhecimento atribuiu a OUTRA pessoa são descartados; "sem match" só vale p/ a mesma pessoa
    ok = [c for c in tr.crops if c['guess'] is None or c['guess'] == ident]
    pending = len(glob.glob(f'{folder}/*.jpg'))
    saved = 0
    for c in ok:
        if saved >= CAND_PER_TRACK or pending + saved >= CAND_MAX:
            break
        if faces.similarity(c['emb'], name) >= CAND_DEDUP:
            continue  # quase igual a algo que já temos
        os.makedirs(folder, exist_ok=True)
        now = datetime.now()
        cv2.imwrite(os.path.join(folder, f"{now.strftime('%d-%m-%Y_%H-%M-%S')}_t{tr.id}_{saved + 1}.jpg"), c['img'],
                    [cv2.IMWRITE_JPEG_QUALITY, 95])
        faces.cand.setdefault(name, []).append(c['emb'])
        saved += 1
    if saved:
        log(f'candidatos: {ident or "_desconhecida"} (+{saved}, pendentes {pending + saved})')


ANIMALS = {'gato', 'cachorro'}


def contained(a, b):
    """Interseção sobre a MENOR das áreas: 1.0 quando uma caixa está inteira dentro da outra."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / smaller if smaller > 0 else 0.0


def plausible_animal(box, person_boxes):
    """Visto de cima e de costas, uma pessoa inclinada sai como "cachorro" ou "gato" (testado nesta câmera: 'cachorro' 0,91 sobre a
    caixa de uma pessoa). Um animal só vale se não estiver em cima de uma pessoa e não for mais alto que largo."""
    w, h = box[2] - box[0], box[3] - box[1]
    if w <= 0 or h > 1.5 * w:
        return False
    return not any(contained(box, p) >= 0.5 for p in person_boxes)


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def match_track(tracks, label, box, used, now):
    """Acha a passagem existente que corresponde a esta detecção: maior sobreposição, ou centro próximo (movimento rápido).
    Diferente do ByteTrack, uma pessoa nova já nasce como passagem no primeiro quadro (sem esperar confirmação)."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    size = max(box[2] - box[0], box[3] - box[1])
    best, best_score = None, 0.0
    for tr in tracks.values():
        if tr.label != label or tr.id in used or now - tr.last > TRACK_TTL:
            continue
        score = iou(tr.box, box)
        if score < 0.15:
            tcx, tcy = (tr.box[0] + tr.box[2]) / 2, (tr.box[1] + tr.box[3]) / 2
            dist = ((cx - tcx) ** 2 + (cy - tcy) ** 2) ** 0.5
            limit = 0.75 * max(size, tr.box[2] - tr.box[0], tr.box[3] - tr.box[1])
            if dist >= limit:
                continue
            score = 0.15 * (1 - dist / limit)  # abaixo de qualquer correspondência por sobreposição
        if score > best_score:
            best, best_score = tr, score
    return best


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    yolo = YOLO(os.environ.get('YOLO_MODEL', f'{MODELS}/yolov8s.pt'))
    faces = Faces()
    faces.load()
    gate = GateMonitor(log)

    def detect_vehicles(frame):
        r = yolo.predict(frame, imgsz=960, conf=0.25, classes=VEHICLE_CLASSES, agnostic_nms=True, verbose=False)[0]
        return [[int(v) for v in b.xyxy[0].tolist()] + [float(b.conf[0]), int(b.cls[0])] for b in r.boxes]  # caixa, confiança, classe
    garage = GarageMonitor(log, detect_vehicles)
    unknown = UnknownAlerts(gate, log)
    health = Health(gate, log)
    grabber = Grabber()
    grabber.start()

    bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=False)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    motion_until = 0
    tracks = {}
    next_tid = 0
    last_saved = {}  # rótulo -> instante; evita repetir quando o tracker troca de ID
    last_seq = 0
    last_face_reload = 0
    last_purge = 0
    period = 1.0 / ANALYZE_FPS
    log('analyzer pronto; saída em', OUT_DIR)

    def try_save(tr, label, now):
        if tr.best is None:
            return
        if now - last_saved.get(label, 0) > COOLDOWN:
            last_saved[label] = now
            path = save_track(tr, label)
            try:
                unknown.handle(label, path, tr.first)
            except Exception as e:  # alerta com problema não pode impedir a gravação
                log('erro no alerta de desconhecido:', repr(e))
        else:
            tr.saved_label = label  # repetido há pouco (ex.: tracker trocou de ID): dá como tratado

    def review(now):
        """Decide o que salvar de cada objeto seguido: confirmou identidade, saiu de cena ou ficou tempo demais."""
        for tid, tr in list(tracks.items()):
            ended = now - tr.last > TRACK_TTL
            if tr.valid:
                if tr.label == 'pessoa':
                    ident = tr.identity()
                    if ident:
                        label = f'pessoa-{ident}'
                        if tr.saved_label != label:
                            try_save(tr, label, now)
                    elif tr.saved_label is None and (ended or (tr.faces_seen and now - tr.first > UNKNOWN_AFTER)):
                        try_save(tr, 'pessoa-desconhecida' if tr.faces_seen else 'pessoa', now)
                elif tr.saved_label is None and (ended or now - tr.first >= 3):
                    try_save(tr, tr.label, now)
            if ended:
                if tr.valid or tr.photos:
                    log(f'passagem {tr.label} #{tr.id}: {tr.hits} detecções em {tr.last - tr.first:.1f} s, {tr.photos} foto(s)')
                elif tr.label == 'pessoa':
                    log(f'descartada pessoa #{tr.id}: {tr.hits} detecção(ões), confiança máxima {tr.max_conf:.2f}')
                try:
                    collect_candidates(tr, faces)
                except Exception as e:
                    log('erro ao guardar candidatos:', repr(e))
                del tracks[tid]

    while True:
        t0 = time.time()
        review(t0)
        if t0 - last_purge > 6 * 3600:  # na partida e a cada 6 h
            last_purge = t0
            try:
                retention.purge(OUT_DIR, int(CONFIG.get('retentionDays', 30)), log)
            except Exception as e:
                log('erro na limpeza de fotos:', repr(e))
        try:
            health.tick(t0)
        except Exception as e:
            log('erro na verificação de saúde:', repr(e))
        frame, last_seq = grabber.latest(last_seq)
        if frame is None:
            time.sleep(0.1)
            continue
        try:
            gate.tick(frame, t0)
        except Exception as e:  # o monitor do portão não pode derrubar a detecção
            log('erro no monitor do portão:', repr(e))
        try:
            garage.tick(frame, t0)
        except Exception as e:  # nem o da garagem
            log('erro no monitor da garagem:', repr(e))
        try:
            if t0 - last_face_reload > 30:
                last_face_reload = t0
                faces.load()

            h, w = frame.shape[:2]
            small = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(frame, (320, max(1, 320 * h // w))), cv2.COLOR_BGR2GRAY), (5, 5), 0)
            mask = cv2.morphologyEx(bg.apply(small), cv2.MORPH_OPEN, kernel)
            ratio = cv2.countNonZero(mask) / mask.size
            if ratio > MOTION_MIN_AREA:
                motion_until = t0 + MOTION_HOLD
            # pessoa ainda em cena e sem identidade confirmada: continua analisando mesmo parada
            if any(t.label == 'pessoa' and t0 - t.last < TRACK_TTL and not t.identity() for t in tracks.values()):
                motion_until = max(motion_until, t0 + 1)
            if t0 > motion_until:
                time.sleep(max(0, period - (time.time() - t0)))
                continue

            res = yolo.predict(frame, imgsz=640, conf=CONF, classes=list(CLASSES), verbose=False)[0]
            for tr in tracks.values():
                tr.cur_face = None
            detections = sorted(((float(b.conf[0]), CLASSES[int(b.cls[0])], [int(v) for v in b.xyxy[0].tolist()]) for b in res.boxes),
                                key=lambda d: -d[0])  # as mais confiantes escolhem primeiro
            person_boxes = [d[2] for d in detections if d[1] == 'pessoa'] + \
                           [t.box for t in tracks.values() if t.label == 'pessoa' and t.box and t0 - t.last <= TRACK_TTL]
            detections = [d for d in detections if d[1] not in ANIMALS or plausible_animal(d[2], person_boxes)]
            if detections:
                gate.note_activity(t0)
            used, persons = set(), []
            for conf, label, box in detections:
                tr = match_track(tracks, label, box, used, t0)
                if tr is None:
                    next_tid += 1
                    tr = tracks[next_tid] = Track(next_tid, label, t0)
                used.add(tr.id)
                tr.last, tr.hits, tr.box = t0, tr.hits + 1, box
                conf = round(conf, 2)
                tr.max_conf = max(tr.max_conf, conf)
                if tr.first_box is None:
                    tr.first_box = box
                elif label != 'pessoa' and not tr.moved:
                    # pessoa andando na frente de um carro parado não conta: só vale se a caixa do objeto mudou de lugar
                    tr.moved = iou(tr.first_box, box) < 0.6
                tr.offer((0, conf), frame, None, conf)
                if label == 'pessoa':
                    persons.append((tr, conf))

            if persons:
                for f in faces.detect(frame):
                    fx, fy, fw, fh = [int(v) for v in f[:4]]
                    # só rostos inteiros (sem tocar a borda do quadro) e grandes o bastante servem para identificar
                    if fw < MIN_FACE or fx < 2 or fy < 2 or fx + fw > w - 2 or fy + fh > h - 2:
                        continue
                    cx, cy = fx + fw / 2, fy + fh / 2
                    owners = [(tr, c) for tr, c in persons if tr.box[0] <= cx <= tr.box[2] and tr.box[1] <= cy <= tr.box[3]]
                    if not owners:
                        continue
                    tr, conf = min(owners, key=lambda o: (o[0].box[2] - o[0].box[0]) * (o[0].box[3] - o[0].box[1]))
                    emb = faces.embed(frame, f)
                    name, score = faces.identify(emb)
                    tr.faces_seen += 1
                    tr.add_crop(frame, f, emb, name)
                    fbox = [fx, fy, fx + fw, fy + fh]
                    tr.cur_face = (fbox, round(float(score), 2) if name else round(float(f[-1]), 2))
                    if name:
                        tr.votes.setdefault(name, []).append(float(score))
                        tr.offer((2, float(score), fw * fh), frame, (fbox, round(float(score), 2)), conf)
                    else:
                        tr.offer((1, fw * fh), frame, (fbox, round(float(f[-1]), 2)), conf)
            # fotos de acompanhamento: uma a cada SEQ_EVERY s enquanto a pessoa está em cena (a primeira sai assim que a passagem vale)
            for tr, conf in persons:
                if SEQ_MAX > 0 and tr.valid and tr.seq_saved < SEQ_MAX and t0 - tr.last_seq_at >= SEQ_EVERY:
                    tr.last_seq_at = t0
                    tr.seq_saved += 1
                    ident = tr.identity()
                    save_track(tr, f'pessoa-{ident}' if ident else 'pessoa',
                               {'frame': frame, 'box': tr.box, 'face': tr.cur_face, 'conf': conf}, final=False)
            review(t0)
        except Exception as e:  # uma falha num quadro não derruba o serviço
            log('erro na análise:', repr(e))
        time.sleep(max(0, period - (time.time() - t0)))


if __name__ == '__main__':
    main()
