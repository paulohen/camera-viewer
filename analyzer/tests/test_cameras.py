# python -m unittest discover -s analyzer/tests   (só biblioteca padrão)
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import cameras  # noqa: E402


def touch(path, text=''):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


class LoadTest(unittest.TestCase):
    def write(self, data):
        d = tempfile.mkdtemp()
        p = os.path.join(d, 'cameras.json')
        with open(p, 'w') as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return p

    def test_missing_file_means_no_cameras(self):
        self.assertEqual(cameras.load('/nao/existe/cameras.json'), [])

    def test_broken_file_is_none_so_running_workers_are_kept(self):
        self.assertIsNone(cameras.load(self.write('{ quebrado')))

    def test_only_enabled_and_analyzed_cameras_with_url(self):
        p = self.write({'cameras': [
            {'id': 'a', 'nome': 'A', 'rtspUrl': 'rtsp://x/live', 'analyzerRtspUrl': 'rtsp://x/main'},
            {'id': 'b', 'nome': 'B', 'rtspUrl': 'rtsp://y/live', 'analyze': False},
            {'id': 'c', 'nome': 'C', 'rtspUrl': 'rtsp://z/live', 'enabled': False},
            {'id': 'd', 'nome': 'D'},
            {'id': 'e', 'rtspUrl': 'rtsp://w/live', 'legacy': True},
        ]})
        got = cameras.load(p)
        self.assertEqual([c['id'] for c in got], ['a', 'e'])
        self.assertEqual(got[0]['url'], 'rtsp://x/main')       # a análise usa o stream principal
        self.assertEqual(got[1]['nome'], 'e')                  # sem apelido: usa o id
        self.assertTrue(got[1]['legacy'])
        self.assertEqual(sorted(cameras.all_ids(p)), ['a', 'b', 'c', 'd', 'e'])


class MigrateTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp()
        self.out, self.gate, self.cars = (os.path.join(root, n) for n in ('data', 'gate', 'cars'))
        self.logs = []
        # layout antigo (uma câmera): tudo na raiz
        touch(os.path.join(self.out, '09-11-2026', '10-00-00_pessoa.jpg'), 'foto')
        touch(os.path.join(self.out, 'solto.txt'), 'nao e dia')
        for f in ('gate.json', 'state.json', 'latest.jpg', 'cars_state.json'):
            touch(os.path.join(self.gate, f), f)
        touch(os.path.join(self.gate, 'faces_status.json'), '{}')
        touch(os.path.join(self.gate, 'refs', 'closed_1.png'), 'png')
        touch(os.path.join(self.cars, 'cars.json'), '{}')
        touch(os.path.join(self.cars, 'polo', '1.jpg'), 'carro')
        touch(os.path.join(self.cars, '_capturas', '2.jpg'), 'cap')

    def run_migration(self, others=()):
        return cameras.migrate_legacy('camera-1', self.out, self.gate, self.cars, list(others), lambda *a: self.logs.append(' '.join(map(str, a))))

    def test_moves_legacy_data_into_the_camera_folders(self):
        self.assertGreater(self.run_migration(), 0)
        j = os.path.join
        self.assertTrue(os.path.exists(j(self.out, 'camera-1', '09-11-2026', '10-00-00_pessoa.jpg')))
        self.assertTrue(os.path.exists(j(self.out, 'solto.txt')))              # o que não é pasta de dia fica
        for f in ('gate.json', 'state.json', 'latest.jpg', 'cars_state.json'):
            self.assertTrue(os.path.exists(j(self.gate, 'camera-1', f)), f)
        self.assertTrue(os.path.exists(j(self.gate, 'camera-1', 'refs', 'closed_1.png')))
        self.assertTrue(os.path.exists(j(self.gate, 'faces_status.json')))     # de todas as câmeras: fica na raiz
        for f in ('cars.json', 'polo/1.jpg', '_capturas/2.jpg'):
            self.assertTrue(os.path.exists(j(self.cars, 'camera-1', f)), f)
        self.assertFalse(os.path.exists(j(self.cars, 'polo')))

    def test_runs_only_once_so_folders_of_removed_cameras_are_not_taken_for_cars(self):
        self.run_migration()
        touch(os.path.join(self.cars, 'camera-removida', 'cars.json'), '{}')    # câmera removida depois
        self.assertEqual(self.run_migration(), 0)
        self.assertTrue(os.path.exists(os.path.join(self.cars, 'camera-removida', 'cars.json')))

    def test_other_cameras_folders_are_not_moved(self):
        touch(os.path.join(self.cars, 'garagem', 'cars.json'), '{}')
        self.run_migration(others=['garagem'])
        self.assertTrue(os.path.exists(os.path.join(self.cars, 'garagem', 'cars.json')))

    def test_never_overwrites(self):
        touch(os.path.join(self.gate, 'camera-1', 'gate.json'), 'novo')
        self.run_migration()
        self.assertEqual(open(os.path.join(self.gate, 'camera-1', 'gate.json')).read(), 'novo')
        self.assertTrue(os.path.exists(os.path.join(self.gate, 'gate.json')))   # o antigo ficou onde estava


if __name__ == '__main__':
    unittest.main()
