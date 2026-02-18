import express from 'express';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const API_KEY = process.env.MCP_API_KEY || 'change-me-in-production';
const PORT = process.env.PORT || 3000;

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const sessions = new Map();

app.get('/sse', requireApiKey, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sessionId = crypto.randomUUID();

  const mcpProcess = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  sessions.set(sessionId, mcpProcess);

  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

  const rl = createInterface({ input: mcpProcess.stdout });
  rl.on('line', (line) => {
    if (line.trim()) {
      res.write(`data: ${line}\n\n`);
    }
  });

  mcpProcess.stderr.on('data', (d) => console.error('[MCP]', d.toString()));

  mcpProcess.on('close', () => {
    sessions.delete(sessionId);
    res.end();
  });

  req.on('close', () => {
    mcpProcess.kill();
    sessions.delete(sessionId);
  });
});

app.post('/messages', requireApiKey, (req, res) => {
  const { sessionId } = req.query;
  const mcpProcess = sessions.get(sessionId);

  if (!mcpProcess) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = JSON.stringify(req.body) + '\n';
  mcpProcess.stdin.write(message);
  res.status(202).json({ status: 'accepted' });
});

// Streamable HTTP endpoint for ServiceNow AI Agent Studio
app.post('/mcp', requireApiKey, (req, res) => {
  console.log('[REQUEST] Method:', req.body?.method);

  const targetId = req.body?.id;

  const mcpProcess = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let responseData = '';

  mcpProcess.stdout.on('data', (data) => {
    responseData += data.toString();
  });

  mcpProcess.stderr.on('data', (d) => console.error('[MCP]', d.toString()));

  mcpProcess.on('close', () => {
    console.log('[RESPONSE] Raw data:', responseData);
    try {
      const lines = responseData.trim().split('\n').filter(l => l.trim());
      // Find the response matching our target request id
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.id === targetId) {
            return res.json(parsed);
          }
        } catch {}
      }
      // Fallback to last line
      const parsed = JSON.parse(lines[lines.length - 1]);
      res.json(parsed);
    } catch (e) {
      console.log('[RESPONSE] Parse error:', e.message);
      res.status(500).json({ error: 'Failed to parse MCP response' });
    }
  });

  // Always send initialize first, then the actual request
  const initMessage = JSON.stringify({
    jsonrpc: '2.0',
    id: 'init-' + targetId,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'proxy', version: '1.0' }
    }
  }) + '\n';

  const actualMessage = JSON.stringify(req.body) + '\n';

  mcpProcess.stdin.write(initMessage);
  mcpProcess.stdin.write(actualMessage);
  mcpProcess.stdin.end();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP HTTP server running on port ${PORT}`);
});