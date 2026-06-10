/*
 * Test fixture: the "grandchild" of a launchCommand wrapper. Mimics
 * next-server, a plain HTTP server that listens on PORT and writes its
 * pid to GRANDCHILD_PID_FILE so the test can clean up if the gate's
 * process-group kill ever regresses.
 */
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.PORT);
if (process.env.GRANDCHILD_PID_FILE) {
  fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid));
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});
server.listen(port, "127.0.0.1");
