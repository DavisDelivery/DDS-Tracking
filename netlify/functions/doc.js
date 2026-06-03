const fetch = require("node-fetch");

const DAVIS_USER = process.env.NUVIZZ_DAVIS_USER || "Chad";
const DAVIS_PASS = process.env.NUVIZZ_DAVIS_PASS;
const ULINE_USER = process.env.NUVIZZ_ULINE_USER || "Chad";
const ULINE_PASS = process.env.NUVIZZ_ULINE_PASS;
const DOC_BASE = "https://portal.nuvizz.com/deliverit/openapi/documentapi/doc/getdocument";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const { guid, ext, company } = params;

  if (!guid || !ext) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing guid or ext" }) };
  }

  // Determine which credentials to use based on company
  const companyCode = (company || "ULINE").toUpperCase();
  let user, pass;
  if (companyCode === "DAVIS") {
    user = DAVIS_USER;
    pass = DAVIS_PASS;
  } else {
    user = ULINE_USER;
    pass = ULINE_PASS;
  }

  try {
    const auth = Buffer.from(`${user}:${pass}`).toString("base64");
    const url = `${DOC_BASE}/${companyCode}?documentGuid=${guid}&objectType=stop&extension=${ext}`;

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: "Document not found" }) };
    }

    const data = await res.json();

    if (!data.documentData) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "No document data" }) };
    }

    // Return as data URI for direct use in img src / iframe
    let mimeType;
    switch (ext.toLowerCase()) {
      case "jpg":
      case "jpeg":
        mimeType = "image/jpeg";
        break;
      case "png":
        mimeType = "image/png";
        break;
      case "pdf":
        mimeType = "application/pdf";
        break;
      default:
        mimeType = "application/octet-stream";
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        dataUri: `data:${mimeType};base64,${data.documentData}`,
        mimeType,
        size: data.documentData.length,
      }),
    };
  } catch (err) {
    console.error("Document fetch error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
