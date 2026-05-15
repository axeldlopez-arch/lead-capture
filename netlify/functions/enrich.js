const fetch = require("node-fetch");

const HUNTER_DOMAIN = "https://api.hunter.io/v2/domain-search";
const HUNTER_FINDER = "https://api.hunter.io/v2/email-finder";
const LEADIQ_GQL = "https://api.leadiq.com/graphql";

const FETCH_TIMEOUT_MS = 8000;

const LEADIQ_SEARCH_PEOPLE = `
  query SearchPeople($input: SearchPeopleInput!) {
    searchPeople(input: $input) {
      totalResults
      results {
        confidence
        currentPositions {
          workEmail { value status }
          emails { value status type }
        }
      }
    }
  }
`;

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

/** Every outbound fetch uses AbortController so slow APIs fail fast (8s) instead of hanging. */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    const name = err && err.name;
    const msg = (err && err.message) || String(err);
    if (name === "AbortError" || msg.includes("aborted")) {
      const e = new Error(`Request timed out after ${timeoutMs}ms`);
      e.cause = err;
      throw e;
    }
    console.log("[fetch] error:", msg);
    throw err;
  } finally {
    clearTimeout(tid);
  }
}

function normConf(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(Math.max(0, Math.min(100, n)));
}

/**
 * Netlify env values are sometimes pasted as `Bearer hm_prod_…` or with quotes.
 * LeadIQ expects `Authorization: Bearer <raw token>` once — duplicate Bearer breaks auth (401).
 */
function sanitizeLeadIQBearerToken(raw) {
  let t = String(raw == null ? "" : raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/^Bearer\s+/i, "").trim();
}

function hunterErrorMessage(data) {
  if (!data || !data.errors || !data.errors.length) return "";
  const e0 = data.errors[0];
  return (e0 && (e0.details || e0.id || e0.message)) || "";
}

async function hunterGet(baseUrl, params) {
  const u = new URL(baseUrl);
  Object.keys(params).forEach((k) => u.searchParams.set(k, String(params[k])));
  const url = u.toString();
  const response = await fetchWithTimeout(url, { method: "GET" });
  const body = await response.json().catch((parseErr) => {
    console.log("Hunter response JSON parse error:", parseErr.message || String(parseErr));
    return {};
  });
  return { response, body };
}

async function lookupHunter(firstName, lastName, companyName, apiKey) {
  const empty = { email: "", confidence: null, source: "hunter", error: "" };
  if (!apiKey || !String(apiKey).trim()) {
    return {
      ...empty,
      error: "HUNTER_API_KEY is not set in Netlify (Site configuration → Environment variables).",
    };
  }
  if (!firstName || !lastName || !companyName) {
    return { ...empty, error: "firstName, lastName, and companyName are required" };
  }
  try {
    console.log("Starting Hunter domain search for: " + companyName);
    const ds = await hunterGet(HUNTER_DOMAIN, {
      company: companyName,
      limit: "1",
      api_key: apiKey,
    });
    console.log("Hunter domain result: " + ds.response.status);

    const he1 = hunterErrorMessage(ds.body);
    if (he1) return { ...empty, error: he1 };
    if (!ds.response.ok) {
      const msg =
        ds.body?.message ||
        ds.body?.errors?.[0]?.details ||
        ds.body?.errors?.[0]?.id ||
        `Hunter domain search failed (${ds.response.status})`;
      return { ...empty, error: msg };
    }
    const domain = ds.body?.data?.domain || "";
    if (!domain) {
      return { ...empty, error: "No domain found for company" };
    }

    console.log("Starting Hunter email finder");
    const ef = await hunterGet(HUNTER_FINDER, {
      domain,
      first_name: firstName,
      last_name: lastName,
      api_key: apiKey,
    });
    console.log("Hunter email result: " + ef.response.status);

    const he2 = hunterErrorMessage(ef.body);
    if (he2) return { ...empty, error: he2 };
    if (!ef.response.ok) {
      const msg =
        ef.body?.message ||
        ef.body?.errors?.[0]?.details ||
        ef.body?.errors?.[0]?.id ||
        `Hunter email finder failed (${ef.response.status})`;
      return { ...empty, error: msg };
    }
    const d = ef.body?.data || {};
    const email = d.email || "";
    if (!email) {
      return { ...empty, confidence: normConf(d.score), error: "No email from Hunter" };
    }
    return {
      email,
      confidence: normConf(d.score),
      source: "hunter",
      error: "",
    };
  } catch (err) {
    console.log("Hunter fetch failed:", err.message || String(err));
    return { ...empty, error: err.message || "Hunter lookup failed" };
  }
}

function pickLeadIQEmail(person) {
  if (!person) return { email: "", confidence: null };
  const conf = normConf(person.confidence);
  const positions = person.currentPositions || [];
  for (const pos of positions) {
    const we = pos && pos.workEmail;
    if (we && we.value && String(we.value).includes("@")) {
      return { email: String(we.value).trim(), confidence: conf };
    }
    const emails = pos.emails || [];
    for (const em of emails) {
      if (em && em.value && String(em.value).includes("@")) {
        return { email: String(em.value).trim(), confidence: conf };
      }
    }
  }
  return { email: "", confidence: conf };
}

async function lookupLeadIQ(firstName, lastName, companyName, linkedinUrl, bearerToken) {
  const empty = { email: "", confidence: null, source: "leadiq", error: "" };
  if (!bearerToken || !String(bearerToken).trim()) {
    return {
      ...empty,
      error: "LEADIQ_API_KEY is not set in Netlify (optional; add Bearer token as environment variable).",
    };
  }
  if (!firstName || !lastName) {
    return { ...empty, error: "Name required" };
  }
  const input = {
    firstName,
    lastName,
    limit: 1,
    company: { name: companyName },
  };
  if (linkedinUrl) input.linkedinUrl = linkedinUrl;

  try {
    console.log("Starting LeadIQ search");
    const response = await fetchWithTimeout(LEADIQ_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        query: LEADIQ_SEARCH_PEOPLE,
        variables: { input },
      }),
    });
    console.log("LeadIQ result: " + response.status);

    const body = await response.json().catch((parseErr) => {
      console.log("LeadIQ response JSON parse error:", parseErr.message || String(parseErr));
      return {};
    });

    if (!response.ok) {
      let msg =
        (Array.isArray(body.errors) && body.errors.map((e) => e.message || e.detail).join("; ")) ||
        `HTTP ${response.status}`;
      if (response.status === 401) {
        msg +=
          " — Check Netlify env LEADIQ_API_KEY: use the raw API token only (do not include the word “Bearer”). Regenerate the token in LeadIQ if it was rotated or expired.";
      }
      return { ...empty, error: msg };
    }
    if (Array.isArray(body.errors) && body.errors.length) {
      return {
        ...empty,
        error: body.errors.map((e) => e.message || String(e)).join("; "),
      };
    }
    const results = body?.data?.searchPeople?.results || [];
    const total = body?.data?.searchPeople?.totalResults;
    const picked = pickLeadIQEmail(results[0]);
    if (!picked.email) {
      const extra = typeof total === "number" && total === 0 ? " (no people matched this name + company)" : "";
      return {
        ...empty,
        confidence: picked.confidence,
        error: "No work email in LeadIQ response" + extra,
      };
    }
    return {
      email: picked.email,
      confidence: picked.confidence,
      source: "leadiq",
      error: "",
    };
  } catch (err) {
    console.log("LeadIQ fetch failed:", err.message || String(err));
    return { ...empty, error: err.message || "LeadIQ request failed" };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const firstName = String(payload.firstName || "").trim();
  const lastName = String(payload.lastName || "").trim();
  const companyName = String(payload.companyName || "").trim();
  const linkedinUrl = String(payload.linkedinUrl || "").trim();

  if (!firstName || !lastName || !companyName) {
    return jsonResponse(400, {
      error: "firstName, lastName, and companyName are required",
    });
  }

  const hunterKey = (process.env.HUNTER_API_KEY || "").trim();
  const leadiqKey = sanitizeLeadIQBearerToken(process.env.LEADIQ_API_KEY || "");

  console.log("enrich: starting Hunter, then LeadIQ (sequential)");

  const hunter = await lookupHunter(firstName, lastName, companyName, hunterKey);
  const leadiq = await lookupLeadIQ(firstName, lastName, companyName, linkedinUrl, leadiqKey);

  console.log("enrich: finished — hunter error:", hunter.error || "(none)", "leadiq error:", leadiq.error || "(none)");

  return jsonResponse(200, { hunter, leadiq });
};
