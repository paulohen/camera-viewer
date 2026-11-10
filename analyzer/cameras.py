# Cadastro de câmeras: lê cameras/cameras.json (escrito pelo painel) e migra as pastas do layout antigo (uma câmera só).
# Só biblioteca padrão, para poder ser testado sem OpenCV.
#
# Cada câmera tem uma pasta própria em cada área compartilhada:
#   OUTPUT_DIR/<id>/dd-mm-yyyy/   fotos das detecções
#   GATE_DIR/<id>/                portão: gate.json, state.json, latest.jpg, refs/, cars_state.json
#   CARS_DIR/<id>/                garagem: cars.json, <carro>/, _capturas/
# Rostos (faces/, faces_candidates/) valem para todas as câmeras.

import json
import os
import re
import shutil

DAY_RE = re.compile(r'^\d{2}-\d{2}-\d{4}$')
CAMERAS_PATH = os.environ.get('CAMERAS_PATH', '/app/cameras/cameras.json')

# arquivos do portão que ficavam na raiz de GATE_DIR (faces_status.json NÃO: ele é de todas as câmeras)
LEGACY_GATE_FILES = ['gate.json', 'state.json', 'latest.jpg', 'latest.tmp.jpg', 'cars_state.json', 'cmd.json', 'refs']


def load(path=CAMERAS_PATH):
    """Câmeras a analisar: [{id, nome, url, legacy}]. Arquivo ausente => []. Arquivo ilegível => None (quem chama mantém o que já roda)."""
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None
    out = []
    for c in data.get('cameras', []):
        url = c.get('analyzerRtspUrl') or c.get('rtspUrl')
        if not c.get('id') or not url or c.get('enabled') is False or c.get('analyze') is False:
            continue
        out.append({'id': c['id'], 'nome': c.get('nome') or c['id'], 'url': url, 'legacy': bool(c.get('legacy'))})
    return out


def _move(src, dst, log):
    if os.path.exists(dst):
        log(f'migração: {dst} já existe, {src} mantido onde está')
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(src, dst)  # mesma montagem => é só um rename, não copia as fotos
    return True


def all_ids(path=CAMERAS_PATH):
    """Ids de TODAS as câmeras cadastradas (inclusive desativadas)."""
    try:
        with open(path) as f:
            return [c['id'] for c in json.load(f).get('cameras', []) if c.get('id')]
    except (OSError, ValueError):
        return []


def migrate_legacy(cam_id, out_dir, gate_dir, cars_dir, other_ids, log):
    """Move os dados do layout antigo (um só dono, direto na raiz das pastas) para as pastas da câmera `cam_id`.
    Roda UMA vez (deixa um marcador): depois disso, pastas na raiz de CARS_DIR são de câmeras removidas, não de carros.
    Nunca sobrescreve. `other_ids` são as demais câmeras cadastradas (suas pastas não são carros)."""
    marker = os.path.join(gate_dir, cam_id, '.legacy-migrated')
    if os.path.exists(marker):
        return 0
    moved = 0
    if os.path.isdir(out_dir):
        for name in sorted(os.listdir(out_dir)):
            src = os.path.join(out_dir, name)
            if DAY_RE.match(name) and os.path.isdir(src) and not os.path.islink(src):
                moved += _move(src, os.path.join(out_dir, cam_id, name), log)
    for name in LEGACY_GATE_FILES:
        src = os.path.join(gate_dir, name)
        if os.path.exists(src):
            moved += _move(src, os.path.join(gate_dir, cam_id, name), log)
    if os.path.isdir(cars_dir):
        skip = {cam_id, *other_ids}
        for name in sorted(os.listdir(cars_dir)):
            if name not in skip:   # cars.json, cmd.json, _capturas e as pastas dos carros cadastrados
                moved += _move(os.path.join(cars_dir, name), os.path.join(cars_dir, cam_id, name), log)
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    open(marker, 'w').close()
    if moved:
        log(f'migração: {moved} item(ns) do layout antigo movidos para as pastas da câmera "{cam_id}"')
    return moved
