# Alertas que não são do portão: pessoa desconhecida (com foto, só em certo horário) e saúde do sistema
# (câmera sem sinal, WhatsApp desconectado). Configuração vem de gate.json, via gate.cfg.

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
        ok, msg = notify.send(f"🚨 {text} às {when.strftime('%H:%M:%S')}.", photo)
        if ok:
            self.last = time.time()
            self.log(f'alerta de desconhecido enviado ({msg})')
        else:
            self.log('falha ao enviar alerta de desconhecido:', msg)


class Health:
    """Avisa quando a câmera some ou o WhatsApp do WAHA desconecta (por Telegram, pois o WhatsApp estaria fora)."""

    def __init__(self, gate, log):
        self.gate, self.log = gate, log
        self.cam_down = False
        self.wa_since = None
        self.wa_alerted = False
        self.last_wa_check = 0.0
        self.next_try = 0.0

    def tick(self, now):
        cfg = self.gate.cfg
        if not cfg['healthEnabled'] or now < self.next_try:
            return
        gap = now - self.gate.last_frame_at
        if not self.cam_down and gap > cfg['cameraDownMin'] * 60:
            ok, msg = notify.send(f'📷 Câmera sem sinal há {fmt_dur(gap)}.')
            self._done(ok, msg, now, 'aviso de câmera sem sinal')
            if ok:
                self.cam_down = True
        elif self.cam_down and gap < 30:
            ok, msg = notify.send('✅ Câmera voltou ao ar.')
            self._done(ok, msg, now, 'aviso de câmera de volta')
            if ok:
                self.cam_down = False

        if notify.whatsapp_configured() and now - self.last_wa_check >= 30:
            self.last_wa_check = now
            status = notify.waha_status()
            if status == 'WORKING':
                self.wa_since = None
                if self.wa_alerted:
                    ok, msg = notify.send('✅ WhatsApp reconectado ao WAHA.')
                    self._done(ok, msg, now, 'aviso de WhatsApp reconectado')
                    if ok:
                        self.wa_alerted = False
            else:
                self.wa_since = self.wa_since or now
                if not self.wa_alerted and now - self.wa_since >= cfg['whatsappDownMin'] * 60:
                    # só Telegram: o WhatsApp está fora; sem Telegram o aviso aparece apenas na página
                    ok, msg = notify.send(f'⚠️ WhatsApp desconectado do WAHA (status: {status}). '
                                          'Os alertas por WhatsApp não chegam até reconectar (leia o QR no painel do WAHA).',
                                          channels=('telegram',))
                    self._done(ok, msg, now, 'aviso de WhatsApp desconectado')
                    if ok:
                        self.wa_alerted = True

    def _done(self, ok, msg, now, what):
        self.log(what, 'enviado' if ok else f'falhou: {msg}')
        if not ok:
            self.next_try = now + 300  # sem canal funcionando: não insiste a cada ciclo
