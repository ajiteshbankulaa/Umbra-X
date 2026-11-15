export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    if (
      incomingUrl.pathname.startsWith('/api/') ||
      incomingUrl.pathname === '/readyz'
    ) {
      const backendBase = (env.BACKEND_URL || '').replace(/\/+$/, '');
      if (!backendBase) {
        return new Response(
          JSON.stringify({ error: 'BACKEND_URL is not configured.' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }

      const reqOrigin = request.headers.get('origin');
      if (reqOrigin && reqOrigin !== incomingUrl.origin) {
        return new Response(
          JSON.stringify({ error: 'Cross-origin request rejected.' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }

      const targetUrl = `${backendBase}${incomingUrl.pathname}${incomingUrl.search}`;
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('origin');
      headers.delete('referer');
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ipcountry');
      headers.delete('cf-ray');
      headers.delete('cf-visitor');
      if (env.UMBRA_API_TOKEN) {
        headers.set('authorization', `Bearer ${env.UMBRA_API_TOKEN}`);
      }

      const init = {
        method: request.method,
        headers,
        redirect: 'manual',
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
      }

      const upstream = await fetch(targetUrl, init);
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('cache-control', 'no-store');
      if ((responseHeaders.get('content-type') || '').includes('text/event-stream')) {
        responseHeaders.set('x-accel-buffering', 'no');
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    return env.ASSETS.fetch(request);
  },
};
