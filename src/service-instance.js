import http from 'node:http';

// 先占住真正的服务端口，再去动共享文件。端口由操作系统持有，崩溃后也会自动释放，
// 所以它比 pid 文件更能说明"这个实例是不是我"。
export async function listenService(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'OC Ferry 正在启动，请稍后重试' } }));
  });
  await new Promise((resolve, reject) => {
    const failed = error => {
      if (error.code === 'EADDRINUSE') error.message = `端口 ${port} 已被占用，OC Ferry 可能已在运行；请检查占用程序后重试。`;
      reject(error);
    };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  return server;
}
