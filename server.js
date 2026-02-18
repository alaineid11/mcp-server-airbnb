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

// Helper: run a sequence of messages and return response for a target id
function runMcpSequence(messages, targetId) {
  return new Promise((resolve, reject) => {
    const mcpProcess = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let responseData = '';

    const rl = createInterface({ input: mcpProcess.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      responseData += line + '\n';
      // Check if we already have the response we need
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === targetId) {
          mcpProcess.kill();
          resolve(parsed);
        }
      } catch {}
    });

    mcpProcess.stderr.on('data', (d) => console.error('[MCP]', d.toString()));

    mcpProcess.on('close', () => {
      // If we haven't resolved yet, try to find the target in all lines
      const lines = responseData.trim().split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.id === targetId) return resolve(parsed);
        } catch {}
      }
      // Last resort: return last line
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        reject(new Error('No valid response found'));
      }
    });

    // Write all messages
    for (const msg of messages) {
      mcpProcess.stdin.write(JSON.stringify(msg) + '\n');
    }
    mcpProcess.stdin.end();

    // Safety timeout
    setTimeout(() => {
      mcpProcess.kill();
      reject(new Error('MCP request timed out'));
    }, 20000);
  });
}

// Streamable HTTP endpoint for ServiceNow AI Agent Studio
app.post('/mcp', requireApiKey, async (req, res) => {
  const method = req.body?.method;
  const targetId = req.body?.id;
  console.log('[REQUEST] Method:', method, 'ID:', targetId);

  try {
    const initMsg = {
      jsonrpc: '2.0',
      id: 'init-' + targetId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'proxy', version: '1.0' }
      }
    };

    if (method === 'initialize') {
      // ServiceNow sends initialize — respond AND proactively fetch tools
      // so that capabilities shows tools are available
      const result = await runMcpSequence([initMsg, req.body], targetId);
      console.log('[RESPONSE]', JSON.stringify(result));
      return res.json(result);
    }

    // For all other methods (tools/list, tools/call, etc.)
    // send init first, then the actual request
    const result = await runMcpSequence([initMsg, req.body], targetId);
    console.log('[RESPONSE]', JSON.stringify(result));
    res.json(result);

  } catch (e) {
    console.error('[ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP HTTP server running on port ${PORT}`);
});