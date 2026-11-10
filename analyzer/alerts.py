# Alertas que não são do portão: pessoa desconhecida (com foto, só em certo horário) e saúde do sistema
# (câmera sem sinal, WhatsApp desconectado). Configuração da câmera vem do gate.json dela (via gate.cfg);
# a do WhatsApp é global (cameras/settings.json).

import time
from datetime import datetime

import notify


def in_window(when, start, end):
    """True se o horário de `when` está entre start e end ('HH:MM'); aceita janela que vira a meia-noite (18:00-07:00)."""
    t = when.hour * 60 + when.minute
    a = int(start[:2]) * 60 + int(start[3:5])
    b = int(end[:2]) * 60 + int(end[3:5])
    if a == b:
        return True
    return a <= t < b if a < b else (t >= a or t < b)


def fmt_dur(sec):
    sec = int(sec)
    if sec < 60:
        return f'{sec} s'
    m = sec // 60
    return f'{m} min' if m < 60 else f'{m // 60} h {m % 60} min'


class UnknownAlerts:
    def __init__(self, gate, log):
        self.gate, self.log = gate, log
        self.last = 0.0

    def handle(self, label, photo_path, seen_at):
        """Chamado quando uma passagem de pessoa é salva. Alerta se for desconhecida e estiver no horário configurado."""
        cfg = self.gate.cfg
        if not cfg['unknownEnabled']:
            return
        if label == 'pessoa-desconhecida':
            text = 'Pessoa desconhecida detectada'
        elif label == 'pessoa' and cfg['unknownIncludeNoFace']:
            text = 'Pessoa detectada (rosto não identificado)'
        else:
            return
        when = datetime.fromtimestamp(seen_at)
        if not in_window(when, cfg['unknownFrom'], cfg['unknownTo']):
            return
        if time.time() - self.last < cfg['unknownCooldownMin'] * 60:
            self.log('alerta de desconhecido suprimido (intervalo mínimo entre alertas)')
            return
        try:
            photo = open(photo_path, 'rb').read()
        except OSError:
            photo = None
        ok, msg = notify.send(notify.with_camera(f"🚨 {text} às {when.strftime('%H:%M:%S')}.", self.gate.name), photo)
        if ok:
            self.last = time.time()
            self.log(f'alerta de desconhecido enviado ({msg})')
        else:
            self.log('falha ao enviar alerta de desconhecido:', msg)


class Health:
    """Avisa quando UMA câmera some (um objeto por câmera). O aviso de WhatsApp desconectado é global: WhatsAppHealth."""

    def __init__(self, gate, log):
        self.gate, self.log = gate, log
        self.cam_down = False
        self.next_try = 0.0

    def tick(self, now):
        cfg = self.gate.cfg
        if not cfg['healthEnabled'] or now < self.next_try:
            return
        gap = now - self.gate.last_frame_at
        name = self.gate.name
        if not self.cam_down and gap > cfg['cameraDownMin'] * 60:
            ok, msg = notify.send(notify.with_camera(f'📷 Câmera sem sinal há {fmt_dur(gap)}.', name))
            self._done(ok, msg, now, 'aviso de câmera sem sinal')
            if ok:
                self.cam_down = True
        elif self.cam_down and gap < 30:
            ok, msg = notify.send(notify.with_camera('✅ Câmera voltou ao ar.', name))
            self._done(ok, msg, now, 'aviso de câmera de volta')
            if ok:
                self.cam_down = False

    def _done(self, ok, msg, now, what):
        self.log(what, 'enviado' if ok else f'falhou: {msg}')
        if not ok:
            self.next_try = now + 300  # sem canal funcionando: não insiste a cada ciclo


class WhatsAppHealth:
    """Avisa (por Telegram, pois o WhatsApp estaria fora) quando o WhatsApp do WAHA desconecta. Um só para todas as câmeras."""

    def __init__(self, log):
        self.log = log
        self.since = None
        self.alerted = False
        self.last_check = 0.0
        self.next_try = 0.0

    def tick(self, now):
        cfg = notify.settings()
        if cfg.get('whatsappAlertEnabled') is False or now < self.next_try:
            return
        if not notify.whatsapp_configured() or now - self.last_check < 30:
            return
        self.last_check = now
        status = notify.waha_status()
        if status == 'WORKING':
            self.since = None
            if self.alerted:
                ok, msg = notify.send('✅ WhatsApp reconectado ao WAHA.')
                self._done(ok, msg, now, 'aviso de WhatsApp reconectado')
                if ok:
                    self.alerted = False
        else:
            self.since = self.since or now
            if not self.alerted and now - self.since >= float(cfg.get('whatsappDownMin', 5)) * 60:
                # só Telegram: o WhatsApp está fora; sem Telegram o aviso aparece apenas na página
                ok, msg = notify.send(f'⚠️ WhatsApp desconectado do WAHA (status: {status}). '
                                      'Os alertas por WhatsApp não chegam até reconectar (leia o QR code no painel, aba Alertas).',
                                      channels=('telegram',))
                self._done(ok, msg, now, 'aviso de WhatsApp desconectado')
                if ok:
                    self.alerted = True

    def _done(self, ok, msg, now, what):
        self.log(what, 'enviado' if ok else f'falhou: {msg}')
        if not ok:
            self.next_try = now + 300
