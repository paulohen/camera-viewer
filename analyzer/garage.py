# Monitor da garagem: avisa quando um carro CADASTRADO chega e para na garagem (e, opcionalmente, quando sai), e,
# se você ligar, quando um carro desconhecido para. Roda a cada poucos segundos, mesmo sem movimento.
#
# Como decide (para cada carro cadastrado):
#  - procura o PADRÃO do carro (mapa de bordas das fotos de cars/<nome>/, capturadas pela própria câmera) dentro da zona
#    "garagem" por correlação normalizada. Nota alta = o carro está lá; nota baixa = não está.
#    Medido nesta câmera: carro presente 0,50-0,98; garagem sem ele 0,19-0,23.
#  - "parou": o padrão aparece e fica no MESMO lugar por `stopSec` segundos; "saiu": some por vários ciclos seguidos.
#  - o que já estava na garagem quando o analyzer iniciou não gera aviso.
#
# Por que não "achar um veículo com o YOLO e depois descobrir qual é": nesta câmera (de cima, carro grande e cortado pela borda)
# o YOLO chama o carro de "avião", chama a parede branca de "avião" e confunde carros da rua; e bordas contra uma "garagem vazia"
# mudam demais com o sol e as sombras. Procurar o carro cadastrado é direto e estável. O YOLO só serve para capturar fotos de
# referência e, se `alertUnknown` estiver ligado, para avisar de carros não cadastrados (apenas classe carro/caminhão, conf. >= 0,5).
#
# Limites: carros do mesmo modelo parados no mesmo lugar podem ser confundidos; a placa não é lida.
#
# Arquivos em CARS_DIR/<id-da-camera>/ (compartilhado com o painel; uma garagem por câmera):
#   cars.json         configuração: zona da garagem, tempos, limiar, carros e opções de aviso
#   <slug>/*.jpg      fotos de referência de cada carro
#   _capturas/*.jpg   recortes recém capturados, à espera de você dizer de qual carro são
#   cmd.json          comando da página (capturar); apagado após executar
# e em GATE_DIR/<id-da-camera>/: cars_state.json (estado para a página).

import glob
import json
import os
import time
from datetime import datetime, timedelta

import cv2
import numpy as np

import notify

TICK = 4.0                 # segundos entre verificações
LEAVE_TICKS = 3            # ciclos seguidos sem ver um carro => saiu
# Para CAPTURAR fotos de referência vale qualquer classe de veículo (o YOLO chama o carro de "avião" nesta câmera).
VEHICLE_CLASSES = [2, 4, 5, 6, 7, 8]   # carro, avião, ônibus, trem, caminhão, barco
UNKNOWN_CLASSES = (2, 7)   # carro desconhecido: só classe carro/caminhão (a parede sai como "avião")...
UNKNOWN_CONF = 0.5         # ...com confiança alta
MIN_ZONE_AREA = 0.06       # o veículo precisa cobrir pelo menos isso da zona (descarta falsos positivos pequenos)
INSIDE_MIN = 0.6           # fração da caixa do veículo que precisa estar dentro da zona
STABLE_TOL = 0.04          # o padrão "está no mesmo lugar" se andar menos que isso da largura da imagem entre ciclos
COME_BACK_SEC = 120        # mesmo carro que saiu e voltou em menos que isso não gera um novo aviso
MAX_CAPTURES = 8
SCALE = 6                  # o casamento é feito com a imagem reduzida 6x (tolera pequenos deslocamentos e ruído)
CORE = 0.7                 # usa a parte central (70%) da foto de referência, sem as bordas com o fundo

DEFAULTS = {
    'garage': None,          # {x, y, w, h} em fração da imagem
    'stopSec': 20,           # tempo parado para considerar que "parou"
    'threshold': 0.40,       # nota mínima (0 a 1) para considerar o carro presente. Medido: presente 0,50-0,98; ausente 0,19-0,23
    'alertUnknown': False,   # avisar quando um carro NÃO cadastrado parar
    'cars': {},              # slug -> {nome, alertOnPark, alertOnLeave}
}


def _write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def overlap(a, b):
    """Interseção sobre a MENOR das áreas: 1.0 quando uma caixa está dentro da outra."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / smaller if smaller > 0 else 0.0


def merge_detections(dets):
    """Une detecções do mesmo veículo (ex.: 'avião' e 'carro' sobre o mesmo carro). Prefere a caixa de classe carro/caminhão."""
    ranked = sorted(dets, key=lambda d: (d[5] in (2, 7) if len(d) > 5 else True, d[4] if len(d) > 4 else 1.0), reverse=True)
    kept = []
    for d in ranked:
        if all(overlap(d[:4], k[:4]) < 0.5 for k in kept):
            kept.append(d)
    return [list(d[:4]) for d in kept]


def edge_map(img):
    """Mapa de bordas (Sobel) da imagem reduzida: independe de cor, brilho e contraste."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (max(1, img.shape[1] // SCALE), max(1, img.shape[0] // SCALE)), interpolation=cv2.INTER_AREA)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    return cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))


def make_template(crop):
    """Parte central do mapa de bordas do recorte de um carro."""
    e = edge_map(crop)
    h, w = e.shape
    mh, mw = int(h * (1 - CORE) / 2), int(w * (1 - CORE) / 2)
    return e[mh:h - mh, mw:w - mw]


def match_in_zone(template, frame_edges, zone):
    """Procura o padrão dentro da zona (px). Retorna (nota, caixa estimada do carro em px). nota -1 se a zona é pequena demais."""
    x1, y1, x2, y2 = [v // SCALE for v in zone]
    region = frame_edges[y1:y2, x1:x2]
    th, tw = template.shape
    if region.shape[0] < th or region.shape[1] < tw or template.std() < 1e-6:
        return -1.0, None
    res = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
    _, score, _, (mx, my) = cv2.minMaxLoc(res)
    cx, cy = (x1 + mx + tw / 2) * SCALE, (y1 + my + th / 2) * SCALE           # centro do padrão
    hw, hh = tw * SCALE / CORE / 2, th * SCALE / CORE / 2                       # o carro inteiro é maior que a parte central usada
    return float(score), [int(cx - hw), int(cy - hh), int(cx + hw), int(cy + hh)]


class RegCar:
    """Acompanha a presença de UM carro cadastrado na garagem."""

    def __init__(self):
        self.state = None          # None (ainda não viu) | 'present' | 'absent'
        self.absent = 0
        self.cand_since = None     # desde quando o padrão está parado no mesmo lugar (ainda como candidato à chegada)
        self.cand_box = None
        self.score = 0.0
        self.box = None
        self.since = None
        self.snap = None           # último quadro com o carro presente (a foto do "saiu" mostra o carro, não a vaga vazia)
        self.snap_box = None


class Unknown:
    """Veículo desconhecido visto pelo YOLO (só usado com alertUnknown ligado)."""

    def __init__(self, box, now, initial):
        self.box, self.anchor, self.stable_since, self.missing = box, box, now, 0
        self.parked, self.initial = initial, initial
        self.snap = None


class GarageMonitor:
    def __init__(self, log, detector, cars_dir, gate_dir, out_dir, name='', clock=time.time):
        """detector(frame) -> lista de caixas [x1,y1,x2,y2(,conf,classe)] de veículos (qualquer classe de VEHICLE_CLASSES).
        cars_dir, gate_dir e out_dir são as pastas DESTA câmera; name é o apelido dela (vai nos avisos)."""
        self.log, self.detector, self.clock = log, detector, clock
        self.cars_dir, self.gate_dir, self.out_dir, self.name = cars_dir, gate_dir, out_dir, name
        os.makedirs(os.path.join(self.cars_dir, '_capturas'), exist_ok=True)
        self.cfg, self.cfg_mtime = dict(DEFAULTS), None
        self.refs, self.refs_sig, self.ref_cache = {}, None, {}
        self.cars = {}             # slug -> RegCar
        self.unknowns = []
        self.started = False
        self.last_tick = 0.0
        self.events = []
        self.last_cmd = None
        self.recent_left = {}      # slug -> instante em que saiu (evita aviso repetido se voltar logo)

    # ---- configuração e referências ----
    def _load_cfg(self):
        path = os.path.join(self.cars_dir, 'cars.json')
        try:
            m = os.path.getmtime(path)
        except OSError:
            return
        if m == self.cfg_mtime:
            return
        self.cfg_mtime = m
        try:
            self.cfg = {**DEFAULTS, **json.load(open(path))}
        except Exception as e:
            self.log('cars.json inválido:', repr(e))

    def _load_refs(self):
        files = sorted(f for f in glob.glob(os.path.join(self.cars_dir, '*', '*.*')) if '/_capturas/' not in f)
        sig = [(f, os.path.getmtime(f)) for f in files]
        if sig == self.refs_sig:
            return
        self.refs_sig, refs = sig, {}
        for f in files:
            key = (f, os.path.getmtime(f))
            if key not in self.ref_cache:
                img = cv2.imread(f)
                self.ref_cache[key] = make_template(img) if img is not None else None
            if self.ref_cache[key] is not None:
                refs.setdefault(os.path.basename(os.path.dirname(f)), []).append(self.ref_cache[key])
        self.ref_cache = {k: v for k, v in self.ref_cache.items() if k in set(sig)}
        self.refs = refs
        for slug in list(self.cars):
            if slug not in refs:
                del self.cars[slug]                      # carro removido ou sem fotos
        self.log('carros cadastrados:', {k: len(v) for k, v in refs.items()} or 'nenhum')

    # ---- geometria ----
    def _zone_px(self, w, h):
        z = self.cfg['garage']
        return [int(z['x'] * w), int(z['y'] * h), int((z['x'] + z['w']) * w), int((z['y'] + z['h']) * h)]

    def _in_zone(self, box, w, h):
        z = self.cfg['garage']
        if not z:
            return False
        cx, cy = (box[0] + box[2]) / 2 / w, (box[1] + box[3]) / 2 / h
        if not (z['x'] <= cx <= z['x'] + z['w'] and z['y'] <= cy <= z['y'] + z['h']):
            return False
        # um carro esperando o portão, só com a ponta dentro da zona, não conta como "na garagem"
        ix = max(0, min(box[2], (z['x'] + z['w']) * w) - max(box[0], z['x'] * w))
        iy = max(0, min(box[3], (z['y'] + z['h']) * h) - max(box[1], z['y'] * h))
        return ix * iy >= INSIDE_MIN * (box[2] - box[0]) * (box[3] - box[1])

    def _big_enough(self, box, w, h):
        z = self.cfg['garage']
        return (box[2] - box[0]) * (box[3] - box[1]) >= MIN_ZONE_AREA * z['w'] * w * z['h'] * h

    def _crop(self, frame, box):
        h, w = frame.shape[:2]
        mx, my = int((box[2] - box[0]) * 0.03), int((box[3] - box[1]) * 0.03)
        return frame[max(0, box[1] - my):min(h, box[3] + my), max(0, box[0] - mx):min(w, box[2] + mx)]

    # ---- ciclo ----
    def tick(self, frame, now=None):
        now = now if now is not None else self.clock()
        if now - self.last_tick < TICK:
            return
        self.last_tick = now
        self._load_cfg()
        if not self.cfg['garage']:
            self._write_state(now, frame)
            return
        self._load_refs()
        h, w = frame.shape[:2]
        zone = self._zone_px(w, h)
        edges = edge_map(frame)
        # o YOLO só roda quando é preciso (capturar referência ou avisar de carro desconhecido)
        wanted = bool(self.cfg['alertUnknown']) or os.path.exists(os.path.join(self.cars_dir, 'cmd.json'))
        dets = [d for d in self.detector(frame) if self._in_zone(d, w, h) and self._big_enough(d, w, h)] if wanted else []
        self._command(frame, merge_detections(dets), now)
        self._presence(frame, edges, zone, now)
        if self.cfg['alertUnknown']:
            self._unknown(frame, [d for d in dets if len(d) > 5 and d[5] in UNKNOWN_CLASSES and d[4] >= UNKNOWN_CONF], now)
        self.started = True
        self._write_state(now, frame)

    # ---- carros cadastrados: presença do padrão ----
    def _presence(self, frame, edges, zone, now):
        first = not self.started
        thr = self.cfg['threshold']
        found = {slug: max((match_in_zone(t, edges, zone) for t in tpls), key=lambda r: r[0]) for slug, tpls in self.refs.items()}
        # dois carros cadastrados "no mesmo lugar" (parecidos): só vale o de maior nota
        for a in found:
            for b in found:
                if a < b and found[a][1] and found[b][1] and found[a][0] >= thr and found[b][0] >= thr \
                        and overlap(found[a][1], found[b][1]) >= 0.6:
                    found[a if found[a][0] < found[b][0] else b] = (-1.0, None)
        for slug, (score, box) in found.items():
            c = self.cars.setdefault(slug, RegCar())
            c.score = round(score, 3)
            here = score >= thr
            if first or c.state is None:
                c.state = 'present' if here else 'absent'              # o que já estava lá (ou foi cadastrado agora): silencioso
                c.since, c.box = now, box if here else None
                if here:
                    c.snap, c.snap_box = frame, box
                continue
            if here:
                c.absent = 0
                if c.state == 'present':
                    c.box, c.snap, c.snap_box = box, frame, box
                    continue
                tol = STABLE_TOL * frame.shape[1]
                if c.cand_box is None or abs(box[0] - c.cand_box[0]) > tol or abs(box[1] - c.cand_box[1]) > tol:
                    c.cand_since, c.cand_box = now, box                 # ainda andando: reinicia a contagem
                if now - c.cand_since >= self.cfg['stopSec']:
                    c.state, c.since, c.box, c.snap, c.snap_box = 'present', now, box, frame, box
                    self._event('parou', slug, frame, box, now)
            else:
                c.cand_since = c.cand_box = None
                if c.state == 'present':
                    c.absent += 1
                    if c.absent >= LEAVE_TICKS:
                        c.state, c.since, c.box = 'absent', now, None
                        self._event('saiu', slug, c.snap if c.snap is not None else frame, c.snap_box, now)

    # ---- carros não cadastrados (YOLO): só com alertUnknown ligado ----
    def _unknown(self, frame, dets, now):
        first = not self.started
        covered = [c.box for c in self.cars.values() if c.state == 'present' and c.box]
        boxes = [b for b in merge_detections(dets) if not any(overlap(b, k) >= 0.5 for k in covered)]   # já é um carro cadastrado
        unmatched = list(boxes)
        for u in list(self.unknowns):
            best = max(unmatched, key=lambda b: overlap(u.box, b), default=None)
            if best is not None and overlap(u.box, best) >= 0.5:
                unmatched.remove(best)
                u.missing = 0
                if overlap(u.anchor, best) < 0.6:
                    u.anchor, u.stable_since = best, now
                if not u.parked:
                    u.box = best
                u.snap = frame
            else:
                u.missing += 1
        for b in unmatched:
            u = Unknown(b, now, first)
            u.snap = frame
            self.unknowns.append(u)
        for u in list(self.unknowns):
            if u.missing >= LEAVE_TICKS:
                self.unknowns.remove(u)
                if u.parked and not u.initial:
                    self._event('saiu', None, u.snap, u.box, now)
            elif not u.parked and u.missing == 0 and now - u.stable_since >= self.cfg['stopSec']:
                u.parked = True
                self._event('parou', None, frame, u.box, now)

    # ---- eventos e avisos ----
    def _name(self, slug):
        return (self.cfg['cars'].get(slug) or {}).get('nome') or slug

    def _event(self, kind, slug, frame, box, now):
        when = datetime.fromtimestamp(now)
        nome = self._name(slug) if slug else None
        score = self.cars[slug].score if slug in self.cars else None
        self.events = ([{'at': now, 'kind': kind, 'nome': nome, 'score': score}] + self.events)[:10]
        self.log(f'garagem: {nome or "carro não cadastrado"} {kind}', f'(nota {score})' if score is not None else '')
        label = f'carro-{slug}' if slug else 'carro-nao-cadastrado'
        photo = self._save_event(kind, slug, nome, frame, box, when, label, score)
        opts = self.cfg['cars'].get(slug) or {}
        if slug and kind == 'saiu':
            self.recent_left[slug] = now
        if slug and kind == 'parou' and now - self.recent_left.get(slug, -1e9) < COME_BACK_SEC:
            self.log(f'{nome} voltou em menos de {COME_BACK_SEC} s: sem novo aviso')
            return
        hhmm = when.strftime('%H:%M:%S')
        if kind == 'parou':
            text = f'🚗 {nome} parou na garagem às {hhmm}.' if slug and opts.get('alertOnPark') else \
                   f'🚗 Carro não cadastrado parou na garagem às {hhmm}.' if not slug and self.cfg['alertUnknown'] else None
        else:
            text = f'🚗 {nome} saiu da garagem às {hhmm}.' if slug and opts.get('alertOnLeave') else None
        if text:
            ok, msg = notify.send(notify.with_camera(text, self.name), photo)
            self.log('aviso da garagem', 'enviado' if ok else f'falhou: {msg}')

    def _save_event(self, kind, slug, nome, frame, box, when, label, score):
        """Grava a foto no mesmo padrão das demais (dd-mm-yyyy/HH-MM-SS_rotulo.jpg + .json); devolve a foto reduzida para o aviso."""
        img = frame.copy()
        h, w = img.shape[:2]
        z = self.cfg['garage']
        cv2.rectangle(img, (int(z['x'] * w), int(z['y'] * h)), (int((z['x'] + z['w']) * w), int((z['y'] + z['h']) * h)), (0, 200, 255), 2)
        if box:
            color = (0, 200, 0) if slug else (255, 140, 0)
            cv2.rectangle(img, (box[0], box[1]), (box[2], box[3]), color, 3)
            cv2.putText(img, f"{nome or 'nao cadastrado'} ({'saiu' if kind == 'saiu' else 'parou'})", (box[0], max(25, box[1] - 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 2)
        try:
            day_dir = os.path.join(self.out_dir, when.strftime('%d-%m-%Y'))
            os.makedirs(day_dir, exist_ok=True)
            while os.path.exists(os.path.join(day_dir, f"{when.strftime('%H-%M-%S')}_{label}.jpg")):
                when += timedelta(seconds=1)  # não sobrescreve uma foto do mesmo rótulo no mesmo segundo
            base = os.path.join(day_dir, f"{when.strftime('%H-%M-%S')}_{label}")
            cv2.imwrite(base + '.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
            _write_json(base + '.json', {'time': when.isoformat(timespec='seconds'), 'label': label, 'evento': kind, 'carro': nome,
                                         'nota': score, 'detections': [{'label': 'carro', 'conf': 1.0, 'box': box or [0, 0, 0, 0]}]})
        except OSError as e:
            self.log('não foi possível gravar a foto da garagem:', e)
        small = cv2.resize(img, (1280, int(img.shape[0] * 1280 / img.shape[1])))
        return cv2.imencode('.jpg', small, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()

    # ---- comandos da página ----
    def _command(self, frame, boxes, now):
        path = os.path.join(self.cars_dir, 'cmd.json')
        if not os.path.exists(path):
            return
        try:
            cmd = json.load(open(path)).get('cmd')
        except Exception:
            cmd = None
        os.remove(path)
        ok, msg = False, 'comando desconhecido'
        if cmd == 'capture':
            if not boxes:
                msg = 'nenhum carro visível na zona da garagem agora'
            else:
                folder = os.path.join(self.cars_dir, '_capturas')
                existing = sorted(glob.glob(os.path.join(folder, '*.jpg')))
                for old in existing[:max(0, len(existing) + len(boxes) - MAX_CAPTURES)]:
                    os.remove(old)
                for i, b in enumerate(boxes):
                    cv2.imwrite(os.path.join(folder, f'{int(now)}_{i + 1}.jpg'), self._crop(frame, b), [cv2.IMWRITE_JPEG_QUALITY, 92])
                ok, msg = True, f'{len(boxes)} carro(s) capturado(s)'
        self.last_cmd = {'cmd': cmd, 'ok': ok, 'msg': msg, 'at': now}
        self.log(f'comando garagem {cmd}: {msg}')

    # ---- estado para a página ----
    def _write_state(self, now, frame):
        h, w = frame.shape[:2]
        norm = lambda b: [round(b[0] / w, 4), round(b[1] / h, 4), round(b[2] / w, 4), round(b[3] / h, 4)] if b else None
        cars = [{'slug': s, 'nome': self._name(s), 'present': c.state == 'present', 'score': c.score, 'since': c.since, 'box': norm(c.box)}
                for s, c in self.cars.items()]
        unknown = [{'box': norm(u.box), 'parked': u.parked} for u in self.unknowns]
        _write_json(os.path.join(self.gate_dir, 'cars_state.json'), {
            'updatedAt': now, 'zoneSet': bool(self.cfg['garage']), 'cars': cars, 'unknown': unknown, 'events': self.events,
            'refs': {k: len(v) for k, v in self.refs.items()}, 'lastCommand': self.last_cmd})
