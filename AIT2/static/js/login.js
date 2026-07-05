const loginById = id => document.getElementById(id);
let workerAccessMode = 'lookup';

function loginMessage(id, message, type = 'error') {
  const node = loginById(id);
  node.textContent = message || '';
  node.className = `access-message${message ? ` show ${type}` : ''}`;
}

async function loginFetch(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || 'Please try again.');
  return payload;
}

function selectAccessType(type) {
  const worker = type === 'worker';
  loginById('workerChoice').classList.toggle('active', worker);
  loginById('adminChoice').classList.toggle('active', !worker);
  loginById('workerPanel').hidden = !worker;
  loginById('adminPanel').hidden = worker;
  (worker ? loginById('workerPhone') : loginById('username')).focus();
}

function resetWorkerLookup() {
  workerAccessMode = 'lookup';
  loginById('workerLookupForm').hidden = false;
  loginById('workerCredentialForm').hidden = true;
  loginById('workerCredentialForm').reset();
  loginById('workerInstruction').textContent = 'Enter your phone number to find your events.';
  loginMessage('workerMessage', '');
  loginById('workerPhone').focus();
}

function configureCredentialForm(discovery) {
  workerAccessMode = discovery.requiresSetup ? 'setup' : 'login';
  loginById('workerLookupForm').hidden = true;
  loginById('workerCredentialForm').hidden = false;
  loginById('credentialPhone').value = discovery.phone;
  loginById('credentialTypeChoice').hidden = !discovery.requiresSetup;
  loginById('confirmationField').hidden = !discovery.requiresSetup;
  loginById('workerCredentialConfirmation').required = discovery.requiresSetup;
  loginById('workerInstruction').textContent = discovery.requiresSetup
    ? `Welcome, ${discovery.name}. Secure your worker account to continue.`
    : `Welcome back, ${discovery.name}. Enter your PIN or password.`;
  loginById('credentialLabel').textContent = discovery.requiresSetup
    ? 'Create a 4–8 digit PIN'
    : 'PIN or password';
  loginById('workerCredential').inputMode = discovery.requiresSetup ? 'numeric' : 'text';
  loginById('workerAccessButton').textContent = discovery.requiresSetup
    ? 'Create PIN & Continue'
    : 'Continue to My Events';
  loginById('workerCredential').focus();
}

function enterWorkerPortal(data) {
  sessionStorage.setItem('aimWorkerPortal', JSON.stringify(data));
  window.location.href = '/worker';
}

loginById('workerChoice').addEventListener('click', () => selectAccessType('worker'));
loginById('adminChoice').addEventListener('click', () => selectAccessType('admin'));
loginById('changeWorkerPhone').addEventListener('click', resetWorkerLookup);

loginById('workerLookupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginById('findEventsButton');
  button.disabled = true;
  loginMessage('workerMessage', '');
  try {
    const response = await loginFetch('/api/worker/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: loginById('workerPhone').value })
    });
    configureCredentialForm(response.data);
  } catch (error) {
    loginMessage('workerMessage', error.message);
  } finally {
    button.disabled = false;
  }
});

loginById('credentialTypeChoice').addEventListener('change', () => {
  const type = document.querySelector('[name="credentialType"]:checked').value;
  const pin = type === 'pin';
  loginById('credentialLabel').textContent = pin ? 'Create a 4–8 digit PIN' : 'Create a password (minimum 8 characters)';
  loginById('confirmationField').querySelector('span').textContent = pin ? 'Confirm PIN' : 'Confirm password';
  loginById('workerCredential').inputMode = pin ? 'numeric' : 'text';
  loginById('workerCredentialConfirmation').inputMode = pin ? 'numeric' : 'text';
  loginById('workerAccessButton').textContent = pin ? 'Create PIN & Continue' : 'Create Password & Continue';
});

loginById('workerCredentialForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginById('workerAccessButton');
  button.disabled = true;
  loginMessage('workerMessage', '');
  const credentialType = document.querySelector('[name="credentialType"]:checked')?.value || 'password';
  try {
    const response = await loginFetch(
      workerAccessMode === 'setup' ? '/api/worker/setup-credentials' : '/api/worker/access',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: loginById('credentialPhone').value,
          password: loginById('workerCredential').value,
          confirmation: loginById('workerCredentialConfirmation').value,
          credentialType
        })
      }
    );
    enterWorkerPortal(response.data);
  } catch (error) {
    loginMessage('workerMessage', error.message);
  } finally {
    button.disabled = false;
  }
});

loginById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginById('loginBtn');
  button.disabled = true;
  loginMessage('adminMessage', '');
  try {
    const response = await loginFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: loginById('username').value,
        password: loginById('password').value
      })
    });
    window.location.href = response.redirect || '/';
  } catch (error) {
    loginMessage('adminMessage', error.message);
  } finally {
    button.disabled = false;
  }
});
