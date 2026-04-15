const https = require('https');

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

function extractPersonFromName(title) {
  // Format: "2026-04 Chris E. — Strive 2.0"
  const match = title.match(/^\d{4}-\d{2}\s+(.+?)\s*[—–-]\s*.+$/);
  return match ? match[1].trim() : null;
}

function extractProjectFromName(title) {
  const match = title.match(/^\d{4}-\d{2}\s+.+?\s*[—–-]\s*(.+)$/);
  return match ? match[1].trim() : null;
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
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
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

      const trimmedContext = context ? context.slice(0, 2500) : '';
      const system = `You are a resource planning assistant for Caribou Digital's ACT pillar. Be concise — max 150 words. Use specific names and numbers. Here is the current team data:\n\n${trimmedContext}`;
      const result = await claudeRequest(messages, system, anthropicKey);
      const reply = result.content?.[0]?.text || result.error?.message || 'No response';
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    // Data endpoint — fetch all six databases in parallel
    const [peopleRows, projectRows, allocRows, loeRows, skillsRows, configRows] = await Promise.all([
      getAllPages(process.env.NOTION_PEOPLE_DB, token),
      getAllPages(process.env.NOTION_PROJECTS_DB, token),
      getAllPages(process.env.NOTION_ALLOCS_DB, token),
      getAllPages(process.env.NOTION_LOE_DB, token),
      getAllPages(process.env.NOTION_SKILLS_DB, token),
      getAllPages(process.env.NOTION_CONFIG_DB, token),
    ]);

    // Config
    const config = {};
    configRows.forEach(r => {
      const name = getProp(r, 'Name');
      const value = getProp(r, 'Value');
      if (name && value !== null) config[name] = value;
    });

    // People
    const peopleById = {};
    const people = peopleRows
      .filter(p => getProp(p, 'Active'))
      .map(p => {
        const level = getProp(p, 'Level');
        const obj = {
          _id: p.id,
          name: getProp(p, 'Name'),
          level,
          fte: getProp(p, 'FTE'),
          fteFromMonth: getProp(p, 'FTE_from_month'),
          fteNew: getProp(p, 'FTE_new'),
          pillar: getProp(p, 'Pillar'),
          country: getProp(p, 'Country'),
          contractType: getProp(p, 'Contract_type'),
          contractEnd: getProp(p, 'Contract_end'),
          superpower: getProp(p, 'Superpower'),
          buyRate: config[`Buy_L${level}`] || null,
          sellRate: config[`Sell_L${level}`] || null,
          target: config[`Target_L${level}`] || null,
        };
        peopleById[p.id] = obj;
        return obj;
      });

    // People lookup by name for plain-text matching
    const peopleByName = {};
    people.forEach(p => { peopleByName[p.name] = p; });

    // Projects
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

    // Projects lookup by name
    const projectsByName = {};
    projects.forEach(p => { projectsByName[p.name] = p; });

    // Helper: resolve person from a row (tries relation first, then text, then name column)
    function resolvePersonName(r) {
      // Try relation
      const relIds = getProp(r, 'Person') || [];
      if (relIds.length > 0 && peopleById[relIds[0]]) return peopleById[relIds[0]].name;
      // Try Person_name text column
      const pName = getProp(r, 'Person_name');
      if (pName && pName.trim()) return pName.trim();
      // Try extracting from Name title
      const title = getProp(r, 'Name') || '';
      return extractPersonFromName(title);
    }

    function resolveProjectName(r) {
      const relIds = getProp(r, 'Project') || [];
      if (relIds.length > 0 && projectsById[relIds[0]]) return projectsById[relIds[0]].name;
      const pName = getProp(r, 'Project_name');
      if (pName && pName.trim()) return pName.trim();
      const title = getProp(r, 'Name') || '';
      return extractProjectFromName(title);
    }

    // Allocations — build as {monthKey: [{p, pr, d, st}]}
    // monthKey = (year-2026)*12 + (month-1)
    const allocsByMonth = {};
    const SO = ["live","contracted","pipeline","internal"];

    allocRows.forEach(r => {
      const personName = resolvePersonName(r);
      const projectName = resolveProjectName(r);
      const year = getProp(r, 'Year');
      const month = getProp(r, 'Month');
      const days = getProp(r, 'Days');
      const status = getProp(r, 'Status') || 'live';
      if (!personName || !projectName || !year || !month || !days) return;

      const person = peopleByName[personName];
      const project = projectsByName[projectName];
      if (!person || !project) return;

      const monthKey = (year - 2026) * 12 + (month - 1);
      if (!allocsByMonth[monthKey]) allocsByMonth[monthKey] = [];
      allocsByMonth[monthKey].push({ p: person.id, pr: project.projectId, d: days, st: status });
    });

    // Sort each month by status order
    Object.keys(allocsByMonth).forEach(k => {
      allocsByMonth[k].sort((a, b) => SO.indexOf(a.st) - SO.indexOf(b.st));
    });

    // LOE — build as {projectName: {personName: {monthKey: days}}}
    const loeByProject = {};
    loeRows.forEach(r => {
      const personName = resolvePersonName(r);
      const projectName = resolveProjectName(r);
      const year = getProp(r, 'Year');
      const month = getProp(r, 'Month');
      const days = getProp(r, 'Days');
      if (!personName || !projectName || !year || !month || !days) return;

      const project = projectsByName[projectName];
      if (!project) return;

      const projId = project.projectId;
      const monthKey = (year - 2026) * 12 + (month - 1);
      if (!loeByProject[projId]) loeByProject[projId] = {};
      if (!loeByProject[projId][personName]) loeByProject[projId][personName] = {};
      loeByProject[projId][personName][monthKey] = days;
    });

    // Skills and themes
    const skillsByPerson = {};
    const themesByPerson = {};

    skillsRows.forEach(r => {
      const personRelIds = getProp(r, 'Person') || [];
      const skill = getProp(r, 'Skill');
      const score = getProp(r, 'Score');
      const type = getProp(r, 'Type');
      if (!skill || score === null) return;

      let personName = null;
      if (personRelIds.length > 0 && peopleById[personRelIds[0]]) {
        personName = peopleById[personRelIds[0]].name;
      }
      if (!personName) {
        const title = getProp(r, 'Name') || '';
        const match = title.match(/^([^—–-]+)\s*[—–-]/);
        if (match) personName = match[1].trim();
      }
      if (!personName) return;

      if (type === 'Theme') {
        if (!themesByPerson[personName]) themesByPerson[personName] = {};
        themesByPerson[personName][skill] = score;
      } else {
        if (!skillsByPerson[personName]) skillsByPerson[personName] = {};
        skillsByPerson[personName][skill] = score;
      }
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        people,
        projects,
        allocations: allocsByMonth,
        loe: loeByProject,
        peopleById,
        projectsById,
        skillsByPerson,
        themesByPerson,
        config
      })
    };

  } catch (err) {
    console.log('Handler error:', err.message);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, reply: 'Server error: ' + err.message })
    };
  }
};
