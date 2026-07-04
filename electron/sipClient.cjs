const sip = require('sip');
const digest = require('sip/digest');
const os = require('os');
const { randomUUID: uuidv4 } = require('crypto');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

let client = null;
let currentConfig = null;
let registerInterval = null;
let cseq = 1;
let currentCallId = null;

function createContactUri() {
  const ip = getLocalIp();
  const transportParam = currentConfig.protocol === 'TCP' ? ';transport=tcp' : '';
  return `sip:${currentConfig.username}@${ip}:5060${transportParam}`;
}

function getServerUri() {
  // VoIP providers often reject strict matches if :5060 is included unnecessarily
  const portPart = currentConfig.port === 5060 ? '' : `:${currentConfig.port}`;
  const transportParam = currentConfig.protocol === 'TCP' ? ';transport=tcp' : '';
  return `sip:${currentConfig.server}${portPart}${transportParam}`;
}

function unq(a) {
  if (a && a[0] === '"' && a[a.length - 1] === '"') {
    return a.substr(1, a.length - 2);
  }
  return a;
}

const SIP_USER_AGENT = 'CallerFlash';

function sendRegister(callbacks) {
  if (!client) return;

  const uri = getServerUri();
  const toUri = `sip:${currentConfig.username}@${currentConfig.server}`;
  
  const rq = {
    method: 'REGISTER',
    uri: uri,
    headers: {
      to: { uri: toUri },
      from: { uri: toUri, params: { tag: currentCallId.substring(0, 8) } },
      'call-id': currentCallId,
      cseq: { method: 'REGISTER', seq: cseq++ },
      contact: [{ uri: createContactUri() }],
      expires: currentConfig.registerExpiry || 300,
      'user-agent': SIP_USER_AGENT,
      'max-forwards': 70,
    }
  };

  client.send(rq, (rs) => {
    if (rs.status === 401 || rs.status === 407) {
      // Digest Challenge
      const authRq = {
        method: 'REGISTER',
        uri: uri,
        headers: {
          to: rq.headers.to,
          from: rq.headers.from,
          'call-id': rq.headers['call-id'],
          cseq: { method: 'REGISTER', seq: cseq++ },
          contact: rq.headers.contact,
          expires: rq.headers.expires,
          'user-agent': SIP_USER_AGENT,
          'max-forwards': 70,
        }
      };

      const creds = {
        user: currentConfig.authUsername || currentConfig.username,
        password: currentConfig.password
      };

      digest.signRequest({}, authRq, rs, creds);

      client.send(authRq, (rs2) => {
        if (rs2.status >= 200 && rs2.status < 300) {
          callbacks.onRegistered();
        } else {
          callbacks.onError(`SIP Registration Failed: ${rs2.status} ${rs2.reason}`);
        }
      });
    } else if (rs.status >= 200 && rs.status < 300) {
      callbacks.onRegistered();
    } else {
      callbacks.onError(`SIP Registration Failed: ${rs.status} ${rs.reason}`);
    }
  });
}

function connect(config, callbacks) {
  disconnect();
  currentConfig = { ...config };
  currentCallId = uuidv4();
  cseq = 1;

  try {
    const isTcp = config.protocol === 'TCP' || config.protocol === 'TLS';
    
    // Start SIP listener
    client = sip.create({
      port: 5060,
      tcp: isTcp,
      udp: !isTcp,
      logger: {
        send: (message, address) => {
          if (message.method !== 'REGISTER') return; // To avoid spamming UI too much, but let's log everything for now
          const msgType = message.method ? message.method : message.status;
          callbacks.onLog(`[SIP Out] ${msgType} -> ${address.address}:${address.port}`);
        },
        recv: (message, address) => {
          const msgType = message.method ? message.method : `${message.status} ${message.reason || ''}`;
          callbacks.onLog(`[SIP In]  ${msgType} <- ${address.address}:${address.port}`);
        },
        error: (e) => callbacks.onError(`Internal SIP error: ${e.message}`)
      }
    }, (rq) => {
      // Handle incoming requests (INVITE)
      if (rq.method === 'INVITE') {
        const callerMatch = rq.headers.from.uri.match(/sip:([^@]+)@/);
        const callerNumber = callerMatch ? callerMatch[1] : 'Unknown';
        let callerName = '';
        if (rq.headers.from.name) {
          callerName = rq.headers.from.name.replace(/^"|"$/g, '');
        }

        // Notify UI immediately
        callbacks.onInvite({ callerNumber, callerName });

        // Reject automatically (CallerFlash is just a monitor, it doesn't answer audio)
        // 486 Busy Here is appropriate for a monitor that doesn't accept the call.
        const rs = sip.makeResponse(rq, 486, 'Busy Here');
        if (!rs.headers) rs.headers = {};
        rs.headers['user-agent'] = SIP_USER_AGENT;
        client.send(rs);
      }
    });

    callbacks.onConnected();

    // Initial Registration
    sendRegister(callbacks);

    // Keep-alive loop
    const expiryMs = (config.registerExpiry || 300) * 1000;
    const refreshMs = Math.max(expiryMs - 15000, 30000); // 15 seconds before expiry, min 30s
    registerInterval = setInterval(() => {
      sendRegister(callbacks);
    }, refreshMs);

  } catch (err) {
    callbacks.onError(err.message);
  }
}

function disconnect() {
  if (registerInterval) {
    clearInterval(registerInterval);
    registerInterval = null;
  }
  
  if (client && currentConfig) {
    // Send un-register (expires: 0)
    try {
      const uri = getServerUri();
      const toUri = `sip:${currentConfig.username}@${currentConfig.server}`;
      const rq = {
        method: 'REGISTER',
        uri: uri,
        headers: {
          to: { uri: toUri },
          from: { uri: toUri, params: { tag: currentCallId.substring(0, 8) } },
          'call-id': currentCallId,
          cseq: { method: 'REGISTER', seq: cseq++ },
          contact: [{ uri: createContactUri() }],
          expires: 0, // 0 = unregister
          'user-agent': SIP_USER_AGENT,
        }
      };
      
      client.send(rq, (rs) => {
        if (rs.status === 401 || rs.status === 407) {
          const authRq = { ...rq, headers: { ...rq.headers, cseq: { method: 'REGISTER', seq: cseq++ } } };
          digest.signRequest({}, authRq, rs, {
            user: currentConfig.authUsername || currentConfig.username,
            password: currentConfig.password
          });
          client.send(authRq);
        }
      });
    } catch { /* ignore */ }

    // Destroy client
    client.destroy();
    client = null;
  }
}

module.exports = { connect, disconnect };
