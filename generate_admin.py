import os
import json
import base64
import hmac
import hashlib

env_vars = {}
if os.path.exists('.env'):
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env_vars[k.strip()] = v.strip().strip('"').strip("'")

jwt_secret = env_vars.get('JWT_SECRET') or 'ribera_secret_key_2026_secure_very_long_and_safe_string'
jwt_issuer = env_vars.get('JWT_ISSUER') or 'ribera-campestre'
jwt_audience = env_vars.get('JWT_AUDIENCE') or 'ribera-app'
nit = env_vars.get('RIBERA_NIT') or '9020699486'

def base64url_encode(data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('utf-8')

header = {'alg': 'HS256', 'typ': 'JWT'}
payload = {
    'sub': '00000000-0000-0000-0000-000000000101',
    'nit': nit,
    'role': 'admin',
    'iss': jwt_issuer,
    'aud': jwt_audience
}

header_json = json.dumps(header, separators=(',', ':'))
payload_json = json.dumps(payload, separators=(',', ':'))

to_sign = f'{base64url_encode(header_json)}.{base64url_encode(payload_json)}'
signature = hmac.new(jwt_secret.encode('utf-8'), to_sign.encode('utf-8'), hashlib.sha256).digest()
jwt_token = f'{to_sign}.{base64url_encode(signature)}'

admin_url = f'https://asamblea-futuro.onrender.com/?token={jwt_token}'

os.makedirs('outputs', exist_ok=True)
with open('outputs/ribera-campestre-admin-link.txt', 'w', encoding='utf-8') as f:
    f.write(admin_url)

print('¡Enlace listo!')
