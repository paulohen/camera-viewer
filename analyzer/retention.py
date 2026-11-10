# Limpeza das fotos antigas em OUTPUT_DIR (pastas dd-mm-yyyy).
# Regras de segurança: só mexe em pastas com nome dd-mm-yyyy (não em links), só apaga arquivos
# HH-MM-SS_*.jpg / .json e só remove a pasta se ela ficar vazia. Qualquer outra coisa é deixada em paz.

import os
import re
from datetime import date, datetime, timedelta

DAY_RE = re.compile(r'^\d{2}-\d{2}-\d{4}$')
FILE_RE = re.compile(r'^\d{2}-\d{2}-\d{2}_[A-Za-z0-9+._-]+\.(jpg|json)$')


def purge(out_dir, days, log, today=None):
    """Apaga fotos de dias anteriores a `days` dias atrás. days <= 0 desliga. Retorna (arquivos, bytes)."""
    if days <= 0 or not os.path.isdir(out_dir):
        return 0, 0
    cutoff = (today or date.today()) - timedelta(days=days)
    files = size = 0
    for name in sorted(os.listdir(out_dir)):
        path = os.path.join(out_dir, name)
        if not DAY_RE.match(name) or os.path.islink(path) or not os.path.isdir(path):
            continue
        try:
            day = datetime.strptime(name, '%d-%m-%Y').date()
        except ValueError:
            continue
        if day >= cutoff:
            continue
        for f in os.listdir(path):
            fp = os.path.join(path, f)
            if FILE_RE.match(f) and os.path.isfile(fp) and not os.path.islink(fp):
                size += os.path.getsize(fp)
                os.remove(fp)
                files += 1
        try:
            os.rmdir(path)  # só funciona se ficou vazia
        except OSError:
            pass
    if files:
        log(f'limpeza: {files} arquivos apagados ({size / 1e6:.1f} MB), fotos com mais de {days} dias')
    return files, size
