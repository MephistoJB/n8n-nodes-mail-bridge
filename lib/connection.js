'use strict';
const TRANSIENT = new Set(['EAI_AGAIN','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','EPIPE','ETIMEDOUT']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function isTransientConnectionError(error) { return TRANSIENT.has(error?.code) || TRANSIENT.has(error?.cause?.code); }
async function connectWithRetry(createClient, maxAttempts = 4, wait = delay) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = createClient();
    try { await client.connect(); return client; }
    catch (error) {
      lastError = error;
      if (client.authenticated) await client.logout().catch(() => undefined);
      else if (typeof client.close === 'function') client.close();
      if (!isTransientConnectionError(error) || attempt === maxAttempts) throw error;
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
module.exports = { connectWithRetry, isTransientConnectionError };
