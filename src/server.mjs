import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

// 服务入口：数据目录可用 DATA_DIR 覆盖，默认 ./data（事件日志落盘，重启可重算）
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url));
const port = Number(process.env.PORT || 3000);
const server = createServer(createApp({ dataDir }));
server.listen(port, () => {
  console.log(`跨境收付款对账中枢已启动: http://localhost:${port}（数据目录 ${dataDir}）`);
});
