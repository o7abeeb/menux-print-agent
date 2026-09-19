/**
 * Talks to the Menux WordPress site's dedicated agent AJAX endpoints
 * (include/menux-printers.php in the theme repo). The agent is never a
 * logged-in WP user -- every call authenticates with the pairing token
 * instead of a nonce, and both endpoints are `nopriv`.
 */

function ajaxUrl(siteUrl) {
  return String(siteUrl).replace(/\/+$/, '') + '/wp-admin/admin-ajax.php';
}

async function postForm(siteUrl, fields) {
  const body = new URLSearchParams(fields);
  const res = await fetch(ajaxUrl(siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('bad_response');
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
