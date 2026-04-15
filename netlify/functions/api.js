const https = require('https');

function notionRequest(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    };
    let data = '';
    const req = https.request(options, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function queryDatabase(dbId, token, startCursor) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {})
    });
    const options = {
      hostname: 'api.notion.com',
      path: `/v1/databases/${dbId}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    let data = '';
    const req = https.request(options, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAllPages(dbId, token) {
  let results = [], cursor = undefined, hasMore = true;
  while (hasMore) {
    const page = await queryDatabase(dbId, token, cursor);
    results = results.concat(page.results || []);
    hasMore = page.has_more;
    cursor = page.next_cursor;
  }
  return results;
}

function getProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  switch (prop.type) {
    case 'title': return prop.title?.[0]?.plain_text || '';
    case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
    case 'number': return prop.number;
    case 'select': return prop.select?.name || null;
    case 'date': return prop.date?.start || null;
    case 'checkbox': return prop.checkbox || false;
    case 'relation': return prop.relation?.map(r => r.id) || [];
    default: return null;
  }
}

async function claudeRequest(messages, system, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      system,
      messages
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    let data = '';
    const req = https.request(options, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = process.env.NOTION_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  try {
    // AI chat endpoint
    if (event.httpMethod === 'POST') {
      let parsed;
      try { parsed = JSON.parse(event.body); }
      catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ reply: 'Invalid request' }) }; }

      const { messages, context } = parsed;
      if (!messages || !messages.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ reply: 'No messages provided' }) };
      }
      if (!anthropicKey) {
        return { statusCode: 500, headers, body: JSON.stringify({ reply: 'API key not configured' }) };
      }

      // Trim context to keep well under timeout — max 2000 chars
      const trimmedContext = context ? context.slice(0, 2000) : '';

      const system = `You are a resource planning assistant for Caribou Digital's ACT pillar. Be concise — max 150 words per response. Use specific names and numbers. Here is the current team data:\n\n${trimmedContext}`;

      const result = await claudeRequest(messages, system, anthropicKey);
      const reply = result.content?.[0]?.text || result.error?.message || 'No response';
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    // Data endpoint (GET)
    const [peopleRows, projectRows, allocRows, loeRows] = await Promise.all([
      getAllPages(process.env.NOTION_PEOPLE_DB, token),
      getAllPages(process.env.NOTION_PROJECTS_DB, token),
      getAllPages(process.env.NOTION_ALLOCS_DB, token),
      getAllPages(process.env.NOTION_LOE_DB, token)
    ]);

    const peopleById = {};
    const people = peopleRows
      .filter(p => getProp(p, 'Active'))
      .map(p => {
        const obj = {
          _id: p.id,
          name: getProp(p, 'Name'),
          level: getProp(p, 'Level'),
          fte: getProp(p, 'FTE'),
          fteFromMonth: getProp(p, 'FTE_from_month'),
          fteNew: getProp(p, 'FTE_new'),
          pillar: getProp(p, 'Pillar'),
          country: getProp(p, 'Country'),
          contractType: getProp(p, 'Contract_type'),
          contractEnd: getProp(p, 'Contract_end'),
          superpower: getProp(p, 'Superpower')
        };
        peopleById[p.id] = obj;
        return obj;
      });

    const projectsById = {};
    const projects = projectRows
      .filter(p => getProp(p, 'Active'))
      .map(p => {
        const obj = {
          _id: p.id,
          name: getProp(p, 'Name'),
          projectId: getProp(p, 'Project_ID'),
          client: getProp(p, 'Client'),
          status: getProp(p, 'Status'),
          endDate: getProp(p, 'End_date'),
          lift: getProp(p, 'Lift')
        };
        projectsById[p.id] = obj;
        return obj;
      });

    const allocations = allocRows.map(r => ({
      personId: getProp(r, 'Person')?.[0],
      projectId: getProp(r, 'Project')?.[0],
      year: getProp(r, 'Year'),
      month: getProp(r, 'Month'),
      days: getProp(r, 'Days'),
      status: getProp(r, 'Status'),
      isActual: getProp(r, 'Is_actual')
    })).filter(a => a.personId && a.projectId && a.days > 0);

    const loe = loeRows.map(r => ({
      personId: getProp(r, 'Person')?.[0],
      projectId: getProp(r, 'Project')?.[0],
      year: getProp(r, 'Year'),
      month: getProp(r, 'Month'),
      days: getProp(r, 'Days')
    })).filter(a => a.personId && a.projectId && a.days > 0);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ people, projects, allocations, loe, peopleById, projectsById })
    };

  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, reply: 'Server error: ' + err.message })
    };
  }
};
