# Envio de alertas: WhatsApp (via WAHA) e Telegram (reserva), com ou sem foto.
#
# Configuração:
#   config.json -> "alerts": { whatsappPhone, wahaUrl, wahaApiKey, wahaSession, telegramBotToken, telegramChatId }
#   cameras/settings.json -> "phone": telefone de destino escolhido na página (vale para todas as câmeras; tem prioridade sobre whatsappPhone)
# Chaves e tokens nunca vão para o log.

import base64
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

CONFIG_PATH = os.environ.get('CONFIG_PATH', '/app/config.json')
SETTINGS_PATH = os.environ.get('SETTINGS_PATH', '/app/cameras/settings.json')


def settings():
    """Ajustes globais escolhidos na página (cameras/settings.json); vazio se não existir."""
    try:
        return json.load(open(SETTINGS_PATH))
    except Exception:
        return {}


def alert_cfg():
    """alerts do config.json; o telefone de destino pode ser trocado pela página (settings.json tem prioridade)."""
    cfg = dict(json.load(open(CONFIG_PATH)).get('alerts', {}))
    phone = settings().get('phone')
    if phone:
        cfg['whatsappPhone'] = phone
    return cfg


def with_camera(text, name):
    """Acrescenta o apelido da câmera ao aviso (com várias câmeras, o aviso precisa dizer de qual veio)."""
    return f'{text}\n📷 {name}' if name else text


def http(method, url, headers=None, body=None, raw=None, timeout=20):
    """Retorna (status, texto). Nunca levanta por status HTTP de erro."""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


# ---------------------------------------------------------------- WhatsApp (WAHA)

_chat_ids = {}  # telefone -> chatId resolvido (o WhatsApp corrige o 9º dígito de números brasileiros)
_status = {'at': 0.0, 'value': None}


def _waha(cfg):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Api-Key': cfg.get('wahaApiKey', '')}
    return cfg['wahaUrl'].rstrip('/'), headers, cfg.get('wahaSession', 'default')


def whatsapp_configured():
    try:
        cfg = alert_cfg()
    except Exception:
        return False
    return bool(cfg.get('whatsappPhone') and cfg.get('wahaUrl') and cfg.get('wahaApiKey'))


def telegram_configured():
    try:
        cfg = alert_cfg()
    except Exception:
        return False
    return bool(cfg.get('telegramBotToken') and cfg.get('telegramChatId'))


def waha_status(max_age=20):
    """Status da sessão do WAHA (WORKING, SCAN_QR_CODE, STOPPED...), com cache."""
    now = time.time()
    if now - _status['at'] < max_age:
        return _status['value']
    try:
        base, headers, session = _waha(alert_cfg())
        code, body = http('GET', f'{base}/api/sessions/{session}', headers, timeout=5)
        value = json.loads(body).get('status') if code == 200 else f'erro {code}'
    except Exception:
        value = 'indisponível'
    _status.update(at=now, value=value)
    return value


def send_whatsapp(text, photo=None):
    if not whatsapp_configured():
        return False, 'WhatsApp não configurado em config.json (alerts)'
    try:
        cfg = alert_cfg()
        base, headers, session = _waha(cfg)
        phone = cfg['whatsappPhone'].lstrip('+')
        status = waha_status(max_age=0)
        if status != 'WORKING':
            return False, f'WhatsApp não conectado (status: {status}); leia o QR code no painel do WAHA'
        chat = _chat_ids.get(phone)
        if not chat:
            code, body = http('GET', f'{base}/api/contacts/check-exists?' + urllib.parse.urlencode({'phone': phone, 'session': session}), headers)
            if code != 200:
                return False, f'falha ao consultar o número (HTTP {code})'
            info = json.loads(body)
            if not info.get('numberExists'):
                return False, 'esse número não tem WhatsApp'
            chat = info.get('pn') or info.get('chatId')
            _chat_ids[phone] = chat
        if photo:
            code, body = http('POST', f'{base}/api/sendImage', headers, {
                'session': session, 'chatId': chat, 'caption': text,
                'file': {'mimetype': 'image/jpeg', 'filename': 'alerta.jpg', 'data': base64.b64encode(photo).decode()}}, timeout=60)
        else:
            code, body = http('POST', f'{base}/api/sendText', headers, {'session': session, 'chatId': chat, 'text': text})
        if code in (200, 201):
            return True, 'enviado'
        _chat_ids.pop(phone, None)
        return False, f'WAHA recusou (HTTP {code}): {body[:120]}'
    except Exception as e:
        return False, f'falha de rede: {type(e).__name__}'


# ---------------------------------------------------------------- Telegram

def _multipart(fields, file_field, filename, content):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
                 f'Content-Type: image/jpeg\r\n\r\n'.encode() + content + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def send_telegram(text, photo=None):
    if not telegram_configured():
        return False, 'Telegram não configurado em config.json (alerts)'
    try:
        cfg = alert_cfg()
        base = f"https://api.telegram.org/bot{cfg['telegramBotToken']}"
        chat = str(cfg['telegramChatId'])
        if photo:
            data, ctype = _multipart({'chat_id': chat, 'caption': text[:1000]}, 'photo', 'alerta.jpg', photo)
            code, body = http('POST', base + '/sendPhoto', {'Content-Type': ctype}, raw=data, timeout=60)
        else:
            code, body = http('POST', base + '/sendMessage', {'Content-Type': 'application/json'}, {'chat_id': chat, 'text': text})
        info = json.loads(body) if body.startswith('{') else {}
        if code == 200 and info.get('ok'):
            return True, 'enviado'
        return False, f"Telegram recusou (HTTP {code}): {str(info.get('description', ''))[:100]}"
    except Exception as e:
        return False, f'falha de rede: {type(e).__name__}'


# ---------------------------------------------------------------- envio com reserva

def send(text, photo=None, channels=('whatsapp', 'telegram')):
    """Tenta os canais na ordem; o seguinte só é usado se o anterior falhar. Retorna (ok, mensagem)."""
    senders = {'whatsapp': send_whatsapp, 'telegram': send_telegram}
    errors = []
    for ch in channels:
        if ch == 'whatsapp' and not whatsapp_configured():
            continue
        if ch == 'telegram' and not telegram_configured():
            continue
        ok, msg = senders[ch](text, photo)
        if ok:
            return True, ch if not errors else f"{ch} (reserva; {'; '.join(errors)})"
        errors.append(f'{ch}: {msg}')
    return False, '; '.join(errors) or 'nenhum canal de alerta configurado'
