// Крошечный STUN: отвечает, с какого адреса и порта пришёл запрос.
// Слушает несколько портов нарочно — симметричный NAT выдаёт новый внешний
// порт на каждого получателя, и по разнице между ответами видно и сам факт,
// и шаг счётчика.
import dgram from 'node:dgram';

const MAGIC = 0x2112a442;
const PORTS = [3478, 3479, 3480, 3481];

const reply = (tid, ip, port) => {
  const buf = Buffer.alloc(32);
  buf.writeUInt16BE(0x0101, 0);
  buf.writeUInt16BE(12, 2);
  buf.writeUInt32BE(MAGIC, 4);
  tid.copy(buf, 8);
  buf.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
  buf.writeUInt16BE(8, 22);
  buf.writeUInt8(0, 24);
  buf.writeUInt8(1, 25);
  buf.writeUInt16BE(port ^ (MAGIC >>> 16), 26);
  const raw = ip.split('.').reduce((n, part) => (n << 8 | Number(part)) >>> 0, 0);
  buf.writeUInt32BE((raw ^ MAGIC) >>> 0, 28);
  return buf;
};

for (const port of PORTS) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
    socket.send(reply(msg.subarray(8, 20), from.address, from.port), from.port, from.address);
  });
  socket.bind(port, () => console.log('STUN слушает', port));
}
