// Device addresses: only plain host names / IP addresses on the home network.
// Nothing here can point the plugin at the internet: no paths, no user:pass@, no public addresses.

// "http://192.168.1.20/", "shelly1-abc.local", "10.0.0.5:8080" -> "192.168.1.20" etc.
function cleanHost(h) {
  const s = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!s || s.length > 100 || s.includes('@')) return '';
  if (/^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(s)) return s.toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(s) ? s.toLowerCase() : '';
}
// private / link-local IPs and local-only names (no dots, .local, .lan, .home, .home.arpa, .internal, .localdomain)
export function isLanHost(h) {
  const host = String(h || '').replace(/:\d{1,5}$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    if (v4.slice(1).some(x => +x > 255)) return false;
    const [a, b] = [+v4[1], +v4[2]];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return /^(fe80|fc|fd)|^::1$/.test(host);
  if (/^[\d.]+$/.test(host)) return false; // a malformed IP, not a name
  return !host.includes('.') || /\.(local|lan|home|home\.arpa|internal|localdomain)$/.test(host);
}
export function lanHost(h) { const c = cleanHost(h); return c && isLanHost(c) ? c : ''; }
export function hostList(v, max = 50) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(raw.map(lanHost).filter(Boolean))].slice(0, max);
}
/** The entries hostList() would drop, for a clear message on the settings page. */
export function rejectedHosts(v) {
  const raw = (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
  return raw.filter(x => !lanHost(x)).slice(0, 5);
}
export const notLanMessage = bad => `${bad.map(x => `"${String(x).slice(0, 60)}"`).join(', ')} ${bad.length === 1 ? "isn't an address" : "aren't addresses"} on your home network. Use the device's IP address (for example 192.168.1.50) or its .local name.`;
