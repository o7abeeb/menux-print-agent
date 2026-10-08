/**
 * Talks to the Menux WordPress site's dedicated agent AJAX endpoints
 * (include/menux-printers.php in the theme repo). The agent is never a
 * logged-in WP user -- every call authenticates with the pairing token
 * instead of a nonce, and both endpoints are `nopriv`.
 */

const AGENT_VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0'; } })();

function ajaxUrl(siteUrl) {
  return String(siteUrl).replace(/\/+$/, '') + '/wp-admin/admin-ajax.php';
}

async function postForm(siteUrl, fields) {
  const body = new URLSearchParams(fields);
  const res = await fetch(ajaxUrl(siteUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MenuxPrintAgent/' + AGENT_VERSION,
      // Some hosts put a JavaScript "Checking your browser…" gate in front
      // of the whole site (seen on the staging host): it lets a request
      // through once its cookie is set, which a browser does by itself and
      // this app never would. Sending that cookie up front keeps the agent
      // from being stuck on the gate page.
      'Cookie': 'hc_js_gate=1',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!json) {
    // An HTML page instead of Menux's JSON: a firewall / bot check in front
    // of the site, or the site doesn't have the printer endpoints yet.
    if (/checking your browser|captcha|challenge|attention required/i.test(text)) throw new Error('blocked_by_site_firewall');
    throw new Error('bad_response_http_' + res.status);
  }
  if (!json.success) throw new Error((json.data && json.data.message) || 'request_failed');
  return json.data;
}

/** Pull up to 20 queued jobs addressed to this agent's printers. */
function pullJobs(siteUrl, token) {
  return postForm(siteUrl, { action: 'menux_printer_agent_pull_jobs', token }).then((d) => d.jobs || []);
}

/** Report a job's outcome back to Menux. */
function ackJob(siteUrl, token, jobId, success, error) {
  return postForm(siteUrl, {
    action: 'menux_printer_agent_ack',
    token,
    job_id: jobId,
    success: success ? '1' : '0',
    error: error || '',
  });
}

module.exports = { pullJobs, ackJob };
