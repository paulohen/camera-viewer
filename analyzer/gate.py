# Monitor do portão: compara uma região da imagem com fotos de referência do portão FECHADO.
# Se a região deixa de se parecer com o portão fechado por tempo suficiente, considera ABERTO;
# aberto por mais de X minutos, manda um alerta com foto (WhatsApp via WAHA; Telegram como reserva).
#
# Arquivos em GATE_DIR (compartilhado com o viewer):
#   gate.json   configuração (escrita pela página): região, limiar, tempos de alerta
#   cmd.json    comando pedido pela página (adicionar referência, testar alerta...); apagado após executar
#   state.json  estado atual (escrito aqui, lido pela página)
#   latest.jpg  último quadro reduzido, para a página desenhar a região
#   refs/       referências do portão fechado

import glob
import json
import os
import time
from collections import deque
from datetime import datetime

import cv2
import numpy as np

import notify

GATE_DIR = os.environ.get('GATE_DIR', '/app/gate')
TICK = 2.0            # s entre avaliações
SNAP_EVERY = 3.0      # s entre atualizações do latest.jpg
SIZE = (128, 128)     # tamanho padrão da região para comparar
MAX_REFS = 6
# Mudança lenta de luz (o sol andando pelo piso) não é abertura de portão: a nota cai devagar e a cena fica parada.
MIN_DROP = 0.12        # queda mínima, abaixo do nível "fechado" recente, para valer como abertura
BACK_TO_CLOSED = 0.08  # volta a "fechado" quando a nota chega a este tanto do nível de antes de abrir
AUTO_MAX = 6           # referências automáticas guardadas (as mais antigas saem)
AUTO_EVERY = 600       # s mínimos entre referências automáticas
AUTO_MAX_SCORE = 0.88  # acima disso a referência atual ainda serve
AUTO_MARGIN = 0.03     # só adota luz nova se a nota estiver pelo menos isso acima do limiar (nunca perto de "aberto")
STABLE_SEC = 60        # a nota precisa ficar estável por isso antes de adotar a luz nova...
STABLE_STD = 0.03
IDLE_SEC = 30          # ...e sem pessoa, carro ou animal em cena
STATE_MAX_AGE = 120    # só restaura o estado salvo se o analyzer esteve fora do ar por menos que isso (s)

DEFAULTS = {
    'enabled': True,
    'roi': None,            # {x, y, w, h} em fração da imagem (0..1)
    'threshold': 0.6,       # similaridade abaixo disso = aberto
    'debounceSec': 10,      # o estado novo precisa durar isso para valer (ignora gente passando na frente)
    'alertAfterMin': 2,     # alerta quando fica aberto por tanto tempo
    'repeatMin': 10,        # repete o alerta a cada tanto enquanto continuar aberto (0 = não repete)
    'notifyClosed': True,   # avisa quando fechar depois de um alerta
    # pessoa desconhecida (alerts.py)
    'unknownEnabled': True,
    'unknownFrom': '18:00',          # janela do alerta; vira a meia-noite
    'unknownTo': '07:00',
    'unknownCooldownMin': 5,         # intervalo mínimo entre alertas de desconhecido
    'unknownIncludeNoFace': False,   # também avisa pessoa cujo rosto não apareceu (muito ruído com câmera alta)
    # saúde do sistema (alerts.py)
    'healthEnabled': True,
    'cameraDownMin': 5,              # câmera sem quadros por tanto tempo => aviso
    'whatsappDownMin': 5,            # WhatsApp desconectado por tanto tempo => aviso (por Telegram)
}


def _write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _fmt_dur(sec):
    sec = int(sec)
    if sec < 60:
        return f'{sec} s'
    m, s = divmod(sec, 60)
    if m < 60:
        return f'{m} min' + (f' {s} s' if s and m < 10 else '')
    h, m = divmod(m, 60)
    return f'{h} h {m} min'


def latest_photo():
    """Último quadro reduzido (latest.jpg) em bytes, se for recente; vai anexado aos alertas."""
    path = os.path.join(GATE_DIR, 'latest.jpg')
    try:
        if time.time() - os.path.getmtime(path) < 30:
            return open(path, 'rb').read()
    except OSError:
        pass
    return None


class GateMonitor:
    def __init__(self, log):
        self.log = log
        os.makedirs(os.path.join(GATE_DIR, 'refs'), exist_ok=True)
        self.cfg, self.cfg_mtime = dict(DEFAULTS), None
        self.refs = []
        self.roi_of_refs = None
        self.last_tick = self.last_snap = 0.0
        self.score = None
        self.raw = None            # 'aberto' | 'fechado' (leitura bruta, sem debounce)
        self.raw_since = None
        self.state, self.since = 'sem-calibracao', None
        self.alerted, self.last_alert, self.last_error, self.next_try = False, 0.0, None, 0.0
        self.hist = deque(maxlen=400)       # (instante, nota): para saber se a cena está estável
        self.level = deque(maxlen=150)      # notas recentes com o portão FECHADO (~5 min): o nível normal desta luz
        self.level_before_open = None
        self.last_auto = self.last_activity = self.slow_logged = 0.0
        self.last_cmd = None
        self.last_frame_at = time.time()   # usado pelo aviso de câmera sem sinal
        self._load_refs()
        self._load_saved_state()

    # ---- persistência ----
    def _load_saved_state(self):
        try:
            s = json.load(open(os.path.join(GATE_DIR, 'state.json')))
            age = time.time() - float(s.get('updatedAt') or 0)
            if age > STATE_MAX_AGE:
                # O analyzer ficou parado (reinício, queda): não dá para saber o que houve com o portão nesse intervalo.
                # Restaurar contaria o tempo desligado como "portão aberto" e mandaria um alerta falso.
                self.log(f'estado salvo do portão tem {int(age // 60)} min: ignorado, recomeçando do zero')
                return
            if s.get('state') in ('aberto', 'fechado'):
                self.state, self.since = s['state'], s.get('since')
                self.alerted = bool(s.get('alert', {}).get('alerted'))
                self.last_alert = s.get('alert', {}).get('lastAlertAt') or 0.0
        except Exception:
            pass

    def _load_refs(self):
        self.refs = []
        for f in sorted(glob.glob(os.path.join(GATE_DIR, 'refs', 'closed_*.png'))) + sorted(glob.glob(os.path.join(GATE_DIR, 'refs', 'auto_*.png'))):
            img = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
            if img is not None:
                self.refs.append(cv2.GaussianBlur(img, (5, 5), 0))

    def _load_cfg(self):
        path = os.path.join(GATE_DIR, 'gate.json')
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
            self.log('gate.json inválido:', repr(e))
            return
        roi_marker = os.path.join(GATE_DIR, 'refs', 'roi.json')
        roi_saved = json.load(open(roi_marker)) if os.path.exists(roi_marker) else None
        if self.refs and roi_saved != self.cfg['roi']:
            self.log('região do portão mudou: referências antigas removidas, recalibre')
            self._clear_refs()

    def _clear_refs(self):
        for f in glob.glob(os.path.join(GATE_DIR, 'refs', 'closed_*.png')) + glob.glob(os.path.join(GATE_DIR, 'refs', 'auto_*.png')):
            os.remove(f)
        self.refs = []
        self.level.clear()

    # ---- imagem ----
    def _crop(self, frame):
        roi = self.cfg['roi']
        if not roi:
            return None
        h, w = frame.shape[:2]
        x1, y1 = int(roi['x'] * w), int(roi['y'] * h)
        x2, y2 = int((roi['x'] + roi['w']) * w), int((roi['y'] + roi['h']) * h)
        if x2 - x1 < 16 or y2 - y1 < 16:
            return None
        return cv2.resize(cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY), SIZE, interpolation=cv2.INTER_AREA)

    def _score(self, crop):
        """Maior correlação (insensível a brilho/contraste) com as referências de portão fechado."""
        if crop is None or not self.refs:
            return None
        blurred = cv2.GaussianBlur(crop, (5, 5), 0)
        best = max(float(np.nan_to_num(cv2.matchTemplate(blurred, r, cv2.TM_CCOEFF_NORMED)[0][0], nan=0.0)) for r in self.refs)
        return round(best, 3)

    # ---- comandos vindos da página ----
    def _command(self, frame, now):
        path = os.path.join(GATE_DIR, 'cmd.json')
        if not os.path.exists(path):
            return
        try:
            cmd = json.load(open(path)).get('cmd')
        except Exception:
            cmd = None
        os.remove(path)
        ok, msg = False, 'comando desconhecido'
        crop = self._crop(frame)
        if cmd == 'add_closed':
            if crop is None:
                msg = 'defina e salve a região do portão primeiro'
            else:
                files = sorted(glob.glob(os.path.join(GATE_DIR, 'refs', 'closed_*.png')))
                for old in files[:max(0, len(files) - MAX_REFS + 1)]:
                    os.remove(old)
                cv2.imwrite(os.path.join(GATE_DIR, 'refs', f'closed_{int(now)}.png'), crop)
                _write_json(os.path.join(GATE_DIR, 'refs', 'roi.json'), self.cfg['roi'])
                self._load_refs()
                ok, msg = True, f'referência adicionada ({len(self.refs)} no total)'
        elif cmd == 'clear_refs':
            self._clear_refs()
            ok, msg = True, 'referências removidas'
        elif cmd == 'calibrate_open':
            s = self._score(crop)
            if s is None:
                msg = 'adicione ao menos uma referência de portão fechado primeiro'
            else:
                thr = round(min(0.85, max(0.3, (0.9 + s) / 2)), 2)
                _write_json(os.path.join(GATE_DIR, 'gate.json'), {**self.cfg, 'threshold': thr})
                self.cfg_mtime = None
                ok, msg = True, f'com o portão aberto a similaridade foi {s}; limiar ajustado para {thr}'
        elif cmd in ('test_alert', 'test_telegram'):
            channel = 'whatsapp' if cmd == 'test_alert' else 'telegram'
            ok, msg = notify.send('✅ Teste do alerta: o envio por ' + ('WhatsApp' if channel == 'whatsapp' else 'Telegram') + ' está funcionando.',
                                  latest_photo(), channels=(channel,))
            msg = 'mensagem de teste enviada (com foto)' if ok else msg
        self.last_cmd = {'cmd': cmd, 'ok': ok, 'msg': msg, 'at': now}
        self.log(f'comando {cmd}: {msg}')

    # ---- ciclo principal ----
    def tick(self, frame, now):
        if now - self.last_tick < TICK:
            return
        self.last_tick = now
        self.last_frame_at = now
        self._load_cfg()
        if now - self.last_snap >= SNAP_EVERY:
            self.last_snap = now
            h, w = frame.shape[:2]
            cv2.imwrite(os.path.join(GATE_DIR, 'latest.tmp.jpg'), cv2.resize(frame, (960, max(1, 960 * h // w))), [cv2.IMWRITE_JPEG_QUALITY, 80])
            os.replace(os.path.join(GATE_DIR, 'latest.tmp.jpg'), os.path.join(GATE_DIR, 'latest.jpg'))
        self._command(frame, now)

        self.score = self._score(self._crop(frame))
        if self.score is None:
            self.state, self.raw = 'sem-calibracao', None
        else:
            if self.state == 'sem-calibracao':
                self.state, self.since = 'fechado', now  # recém calibrado: assume o estado atual como ponto de partida
            thr = self.cfg['threshold']
            if self.state == 'aberto':
                # volta a "fechado" ao passar do limiar OU ao chegar perto do nível de antes de abrir (luz forte: nível normal baixo)
                back = self.level_before_open is not None and self.score >= self.level_before_open - BACK_TO_CLOSED
                raw = 'fechado' if (self.score >= thr or back) else 'aberto'
            else:
                level = self._closed_level()
                abrupt = level is None or (level - self.score) >= MIN_DROP
                raw = 'aberto' if (self.score < thr and abrupt) else 'fechado'
                if self.score < thr and not abrupt and now - self.slow_logged > 600:
                    self.slow_logged = now
                    self.log(f'nota baixou devagar ({self.score}, nível normal {level:.2f}): mudança de luz, não é abertura do portão')
                if raw == 'fechado':
                    self.level.append((now, self.score))
            self.hist.append((now, self.score))
            if raw != self.raw:
                self.raw, self.raw_since = raw, now
            if raw != self.state and now - self.raw_since >= self.cfg['debounceSec']:
                self.log(f'portão {raw} (similaridade {self.score})')
                self.state, self.since = raw, self.raw_since
                if raw == 'fechado':
                    self._on_closed(now)
                else:
                    self.alerted, self.last_alert = False, 0.0
                    self.level_before_open = self._closed_level()
            self._maybe_auto_ref(frame, now)
        if self.state == 'aberto' and self.cfg['enabled']:
            self._maybe_alert(now)
        self._write_state(now)

    def note_activity(self, now):
        """O analyzer avisa quando há pessoa, carro ou animal em cena: nessa hora não se adota luz nova como referência."""
        self.last_activity = now

    def _closed_level(self):
        v = [s for _, s in self.level]
        return float(np.median(v)) if len(v) >= 15 else None

    def _maybe_auto_ref(self, frame, now):
        """Acompanha a luz: com o portão claramente fechado e a cena parada, guarda a imagem atual como referência."""
        if self.state != 'fechado' or self.raw != 'fechado' or self.score is None:
            return
        if now - self.last_auto < AUTO_EVERY or now - self.last_activity < IDLE_SEC:
            return
        recent = [s for t, s in self.hist if now - t <= STABLE_SEC]
        if len(recent) < 0.8 * STABLE_SEC / TICK or float(np.std(recent)) > STABLE_STD:
            return
        mean = float(np.mean(recent))
        if not (self.cfg['threshold'] + AUTO_MARGIN <= mean <= AUTO_MAX_SCORE):
            return
        crop = self._crop(frame)
        if crop is None:
            return
        autos = sorted(glob.glob(os.path.join(GATE_DIR, 'refs', 'auto_*.png')))
        for old in autos[:max(0, len(autos) - AUTO_MAX + 1)]:
            os.remove(old)
        cv2.imwrite(os.path.join(GATE_DIR, 'refs', f'auto_{int(now)}.png'), crop)
        self._load_refs()
        self.last_auto = now
        self.level.clear()
        self.log(f'luz nova adotada como referência automática (nota era {mean:.2f}; {len(self.refs)} referências)')

    def _maybe_alert(self, now):
        open_for = now - (self.since or now)
        repeat = self.cfg['repeatMin'] * 60
        due = open_for >= self.cfg['alertAfterMin'] * 60 and (
            not self.alerted or (repeat and now - self.last_alert >= repeat))
        if not due or now < self.next_try:
            return
        since = datetime.fromtimestamp(self.since).strftime('%H:%M:%S')
        ok, msg = notify.send(f'⚠️ Portão aberto há {_fmt_dur(open_for)} (desde {since}).', latest_photo())
        if ok:
            self.alerted, self.last_alert, self.last_error = True, now, None
            self.log('alerta de portão aberto enviado')
        else:
            self.last_error, self.next_try = msg, now + 60
            self.log('falha ao enviar alerta:', msg)

    def _on_closed(self, now):
        was_alerted = self.alerted
        self.alerted, self.last_alert = False, 0.0
        if was_alerted and self.cfg['notifyClosed'] and self.cfg['enabled']:
            ok, msg = notify.send('✅ Portão fechado.')
            self.log('aviso de portão fechado', 'enviado' if ok else f'falhou: {msg}')

    def _write_state(self, now):
        try:
            phone = notify.alert_cfg().get('whatsappPhone')
        except Exception:
            phone = None
        _write_json(os.path.join(GATE_DIR, 'state.json'), {
            'state': self.state, 'since': self.since, 'score': self.score, 'threshold': self.cfg['threshold'],
            'refs': len(self.refs), 'autoRefs': len(glob.glob(os.path.join(GATE_DIR, 'refs', 'auto_*.png'))),
            'roiSet': bool(self.cfg['roi']), 'updatedAt': now,
            'openSeconds': round(now - self.since) if self.state == 'aberto' and self.since else 0,
            'alert': {'enabled': self.cfg['enabled'], 'alerted': self.alerted,
                      'lastAlertAt': self.last_alert or None, 'lastError': self.last_error, 'phone': phone,
                      'whatsappConfigured': notify.whatsapp_configured(), 'telegramConfigured': notify.telegram_configured(),
                      'link': notify.waha_status() if notify.whatsapp_configured() else None},
            'lastCommand': self.last_cmd,
        })
