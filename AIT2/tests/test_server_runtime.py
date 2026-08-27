import os
import unittest
from unittest.mock import patch

from flask import Flask

import app as app_module


class ServerRuntimeTests(unittest.TestCase):
    def test_waitress_behind_https_proxy_keeps_secure_request_settings(self):
        flask_app = Flask(__name__)
        environment = {
            'ENABLE_HTTPS': '0',
            'EXTERNAL_HTTPS': '1',
            'HOST': '127.0.0.1',
            'PORT': '5055',
            'SERVER_BACKEND': 'waitress',
            'WAITRESS_THREADS': '32',
            'WAITRESS_TRUSTED_PROXY': '127.0.0.1',
        }

        with patch.dict(os.environ, environment, clear=False), patch(
            'waitress.serve'
        ) as waitress_serve:
            app_module.run_https_app(flask_app)

        options = waitress_serve.call_args.kwargs
        self.assertEqual(flask_app.config['PREFERRED_URL_SCHEME'], 'https')
        self.assertTrue(flask_app.config['SESSION_COOKIE_SECURE'])
        self.assertEqual(options['host'], '127.0.0.1')
        self.assertEqual(options['port'], 5055)
        self.assertEqual(options['url_scheme'], 'https')
        self.assertEqual(options['trusted_proxy'], '127.0.0.1')
        self.assertIn('x-forwarded-proto', options['trusted_proxy_headers'])


if __name__ == '__main__':
    unittest.main()
