import http from 'node:http';

export function startMockServer(port: number = 3888): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        if (req.url === '/login' || req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>App Portal Login</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; display: flex; justify-content: center; align-items: center; min-height: 80vh; margin: 0; }
                .login-card { background: #1e293b; border: 1px solid #334155; padding: 32px; border-radius: 12px; width: 360px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                h2 { margin-top: 0; font-size: 22px; color: #38bdf8; }
                label { font-size: 13px; color: #94a3b8; font-weight: 500; }
                input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-top: 6px; margin-bottom: 16px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: white; outline: none; }
                input:focus { border-color: #38bdf8; }
                button { width: 100%; background: #0284c7; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
                button:hover { background: #0369a1; }
              </style>
            </head>
            <body>
              <div class="login-card">
                <h2>⚡ Enterprise Portal</h2>
                <form id="login-form" action="/dashboard" method="GET">
                  <div>
                    <label>Username</label>
                    <input id="username" name="user" type="text" placeholder="user@corp.internal" required />
                  </div>
                  <div>
                    <label>Password</label>
                    <input id="password" name="pass" type="password" placeholder="••••••••" required />
                  </div>
                  <button id="login-btn" type="submit">Sign In to Dashboard</button>
                </form>
              </div>
            </body>
            </html>
          `);
        } else if (req.url?.startsWith('/dashboard')) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Enterprise Order Processing</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; padding: 30px; margin: 0; }
                .container { max-width: 720px; margin: 0 auto; }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
                h1 { font-size: 22px; margin: 0; color: #38bdf8; }
                .badge { background: #1e293b; border: 1px solid #334155; padding: 4px 10px; border-radius: 20px; font-size: 13px; font-weight: 600; color: #34d399; }
                .order-box { background: #161f30; border: 1px solid #223048; border-radius: 10px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
                .btn { background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 15px; cursor: pointer; transition: all 0.15s; }
                .btn:hover:not(:disabled) { background: #059669; }
                .btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .confirmation-banner { display: none; background: rgba(16, 185, 129, 0.12); border: 1px solid #10b981; border-radius: 8px; padding: 14px 18px; margin-top: 18px; animation: fadeIn 0.2s ease-in-out; }
                .order-title { font-weight: 700; color: #34d399; font-size: 16px; margin-bottom: 4px; }
                .order-meta { font-size: 13px; color: #94a3b8; font-family: monospace; }
                .history-card { background: #161f30; border: 1px solid #223048; border-radius: 10px; padding: 20px; }
                .history-header { font-size: 14px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 12px; }
                .order-row { display: flex; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; font-family: monospace; }
                .order-row:last-child { border-bottom: none; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1 id="welcome">⚡ High-Throughput Order Gateway</h1>
                  <span id="orders-badge" class="badge">Orders Placed: <strong id="order-count">0</strong></span>
                </div>

                <div class="order-box">
                  <h3 style="margin-top: 0; color: #f1f5f9;">Instant Order Dispatch</h3>
                  <p style="color: #94a3b8; font-size: 14px; margin-bottom: 18px;">Click below to dispatch a transactional order directly to the backend processing pipeline.</p>
                  
                  <button id="checkout-btn" class="btn" onclick="submitOrder()">
                    🚀 Place Order ($149.00)
                  </button>

                  <div id="order-confirmation" class="confirmation-banner">
                    <div id="confirmation-title" class="order-title"></div>
                    <div id="confirmation-meta" class="order-meta"></div>
                  </div>
                </div>

                <div class="history-card">
                  <div class="history-header">Recent Real-time Orders Feed</div>
                  <div id="orders-feed">
                    <div id="empty-state" style="color: #64748b; font-size: 13px; font-style: italic;">No orders placed yet in this session.</div>
                  </div>
                </div>
              </div>

              <script>
                let totalOrders = 0;

                function submitOrder() {
                  const btn = document.getElementById('checkout-btn');
                  const banner = document.getElementById('order-confirmation');
                  const title = document.getElementById('confirmation-title');
                  const meta = document.getElementById('confirmation-meta');
                  const countElem = document.getElementById('order-count');
                  const feed = document.getElementById('orders-feed');
                  const empty = document.getElementById('empty-state');

                  btn.disabled = true;
                  btn.innerText = '⏳ Submitting to Payment Gateway...';
                  banner.style.display = 'none';

                  // Simulated backend processing time (70ms)
                  setTimeout(() => {
                    totalOrders++;
                    const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
                    const now = new Date().toLocaleTimeString();

                    countElem.innerText = totalOrders;
                    banner.setAttribute('data-order-id', orderId);
                    banner.setAttribute('data-order-seq', totalOrders);
                    title.innerText = '✅ Order #' + orderId + ' Confirmed!';
                    meta.innerText = 'Timestamp: ' + now + ' • Status: 200 OK (Payment Settled)';
                    banner.style.display = 'block';

                    if (empty) empty.remove();
                    const row = document.createElement('div');
                    row.className = 'order-row';
                    row.innerHTML = '<span>' + orderId + '</span><span style="color: #34d399;">$149.00 (APPROVED)</span><span style="color: #64748b;">' + now + '</span>';
                    feed.insertBefore(row, feed.firstChild);

                    // Re-enable button for the next rapid transaction
                    btn.disabled = false;
                    btn.innerText = '🚀 Place Order ($149.00)';
                  }, 70);
                }
              </script>
            </body>
            </html>
          `);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      }, 25);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}
