import type * as ZendeskTypes from "node-zendesk";
import zendesk from "node-zendesk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parse } from "node-html-parser";

// Types for exported functions
export interface ZendeskConfig {
  email: string;
  token: string;
  subdomain: string;
}

// Create Zendesk client
export function createZendeskClient(config: ZendeskConfig) {
  return zendesk.createClient({
    username: config.email,
    token: config.token,
    remoteUri: `https://${config.subdomain}.zendesk.com/api/v2`,
  });
}

// Exported read-only tool functions
export async function getTicket(client: any, ticketId: number): Promise<any> {
  return new Promise((resolve, reject) => {
    client.tickets.show(ticketId, (error: Error | undefined, req: any, result: any) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

export async function searchTickets(client: any, query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    client.search.query(query, (error: Error | undefined, req: any, result: any) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

export async function getTicketDetails(client: any, ticketId: number): Promise<any> {
  const ticketResult = await getTicket(client, ticketId);
  
  const commentsResult = await new Promise((resolve, reject) => {
    client.tickets.getComments(ticketId, (error: Error | undefined, req: any, result: any) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });

  return {
    ticket: ticketResult,
    comments: commentsResult
  };
}

export interface CleanedComment {
  id: number;
  author_id: number;
  created_at: string;
  public: boolean;
  type: string;
  text: string;
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "tr", "article", "section", "ul", "ol", "table",
]);

const escapeBrackets = (s: string) => s.replace(/([\[\]])/g, "\\$1");

const formatUrl = (href: string) =>
  /[() <>]/.test(href) ? `<${href}>` : href;

function nodeToMarkdown(node: any): string {
  // Text node — escape brackets so raw text doesn't accidentally form markdown link syntax
  if (node.nodeType === 3) {
    return escapeBrackets(node.text ?? node.rawText ?? "");
  }

  const tag = (node.tagName ?? "").toLowerCase();
  const children: any[] = node.childNodes ?? [];
  const inner = children.map(nodeToMarkdown).join("");

  switch (tag) {
    case "a": {
      const href = node.getAttribute("href") ?? "";
      const text = inner.trim();
      if (!href) return inner;
      if (!text || text === href) return `<${href}>`;
      // inner already escaped where needed — preserves nested ![alt](src) for clickable images
      return `[${text}](${formatUrl(href)})`;
    }
    case "img": {
      const src = node.getAttribute("src") ?? "";
      const alt = escapeBrackets(node.getAttribute("alt") ?? "");
      if (!src) return alt;
      return `![${alt}](${formatUrl(src)})`;
    }
    case "br":
      return "\n";
    case "code":
      return inner ? `\`${inner}\`` : "";
    default:
      if (BLOCK_TAGS.has(tag)) return inner + "\n";
      return inner;
  }
}

function htmlToMarkdown(html: string): string {
  if (!html) return "";
  const root = parse(html);
  const md = nodeToMarkdown(root);
  return md
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getTicketDetailsClean(client: any, ticketId: number): Promise<any> {
  const ticket = await getTicket(client, ticketId);
  const commentsResp: any = await new Promise((resolve, reject) => {
    client.tickets.getComments(ticketId, (error: Error | undefined, _req: any, result: any) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  const rawComments: any[] = Array.isArray(commentsResp)
    ? commentsResp
    : (commentsResp?.comments ?? []);

  const comments: CleanedComment[] = rawComments.map(c => ({
    id: c.id,
    author_id: c.author_id,
    created_at: c.created_at,
    public: c.public,
    type: c.type,
    text: htmlToMarkdown(c.html_body ?? ""),
  }));

  return { ticket, comments };
}

export async function getLinkedIncidents(client: any, ticketId: number): Promise<any> {
  return new Promise((resolve, reject) => {
    client.tickets.listIncidents(ticketId, (error: Error | undefined, req: any, result: any) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

export function createZendeskClientFromEnv() {
  if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_TOKEN || !process.env.ZENDESK_SUBDOMAIN) {
    throw new Error('Missing required environment variables: ZENDESK_EMAIL, ZENDESK_TOKEN, ZENDESK_SUBDOMAIN');
  }
  return createZendeskClient({
    email: process.env.ZENDESK_EMAIL,
    token: process.env.ZENDESK_TOKEN,
    subdomain: process.env.ZENDESK_SUBDOMAIN,
  });
}

export function zenDeskTools(server: McpServer, client: any) {
  server.tool(
    "zendesk_get_ticket",
    "Get a Zendesk ticket by ID",
    {
      ticket_id: z.string().describe("The ID of the ticket to retrieve"),
    },
    async ({ ticket_id }) => {
      try {
        const result = await getTicket(client, parseInt(ticket_id, 10));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_update_ticket",
    "Update a Zendesk ticket's properties",
    {
      ticket_id: z.string().describe("The ID of the ticket to update"),
      subject: z.string().optional().describe("The new subject of the ticket"),
      status: z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']).optional().describe("The new status of the ticket"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("The new priority of the ticket"),
      type: z.enum(['problem', 'incident', 'question', 'task']).optional().describe("The new type of the ticket"),
      assignee_id: z.string().optional().describe("The ID of the agent to assign the ticket to"),
      tags: z.array(z.string()).optional().describe("Tags to set on the ticket (replaces existing tags)")
    },
    async ({ ticket_id, subject, status, priority, type, assignee_id, tags }) => {
      try {
        const ticketData: any = {
          ticket: {}
        };

        // Only add properties that are provided
        if (subject) ticketData.ticket.subject = subject;
        if (status) ticketData.ticket.status = status;
        if (priority) ticketData.ticket.priority = priority;
        if (type) ticketData.ticket.type = type;
        if (assignee_id) ticketData.ticket.assignee_id = parseInt(assignee_id, 10);
        if (tags) ticketData.ticket.tags = tags;

        const result = await new Promise((resolve, reject) => {
          (client as any).tickets.update(parseInt(ticket_id, 10), ticketData, (error: Error | undefined, req: any, result: any) => {
            if (error) {
              console.log(error);
              reject(error);
            } else {
              resolve(result);
            }
          });
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_create_ticket",
    "Create a new Zendesk ticket",
    {
      subject: z.string().describe("The subject of the ticket"),
      description: z.string().describe("The initial description or comment for the ticket"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("The priority of the ticket"),
      status: z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']).optional().describe("The status of the ticket"),
      type: z.enum(['problem', 'incident', 'question', 'task']).optional().describe("The type of the ticket"),
      tags: z.array(z.string()).optional().describe("Tags to add to the ticket")
    },
    async ({ subject, description, priority, status, type, tags }) => {
      try {
        const ticketData: any = {
          ticket: {
            subject,
            comment: { body: description },
          }
        };

        if (priority) ticketData.ticket.priority = priority;
        if (status) ticketData.ticket.status = status;
        if (type) ticketData.ticket.type = type;
        if (tags) ticketData.ticket.tags = tags;

        const result = await new Promise((resolve, reject) => {
          (client as any).tickets.create(ticketData, (error: Error | undefined, req: any, result: any) => {
            if (error) {
              console.log(error);
              reject(error);
            } else {
              resolve(result);
            }
          });
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_add_private_note",
    "Add a private internal note to a Zendesk ticket",
    {
      ticket_id: z.string().describe("The ID of the ticket to add a note to"),
      note: z.string().describe("The content of the private note")
    },
    async ({ ticket_id, note }) => {
      try {
        const result = await new Promise((resolve, reject) => {
          (client as any).tickets.update(parseInt(ticket_id, 10), {
            ticket: {
              comment: {
                body: note,
                public: false
              }
            }
          }, (error: Error | undefined, req: any, result: any) => {
            if (error) {
              console.log(error);
              reject(error);
            } else {
              resolve(result);
            }
          });
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_add_public_note",
    "Add a public comment to a Zendesk ticket",
    {
      ticket_id: z.string().describe("The ID of the ticket to add a comment to"),
      comment: z.string().describe("The content of the public comment")
    },
    async ({ ticket_id, comment }) => {
      try {
        const result = await new Promise((resolve, reject) => {
          (client as any).tickets.update(parseInt(ticket_id, 10), {
            ticket: {
              comment: {
                body: comment,
                public: true
              }
            }
          }, (error: Error | undefined, req: any, result: any) => {
            if (error) {
              console.log(error);
              reject(error);
            } else {
              resolve(result);
            }
          });
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_search",
    "Search for Zendesk tickets based on a query",
    {
      query: z.string().describe("Search query (e.g., 'status:open', 'priority:urgent', 'tags:need_help')"),
    },
    async ({ query }) => {
      try {
        const result = await searchTickets(client, query);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_get_ticket_details",
    "Get detailed information about a Zendesk ticket including comments",
    {
      ticket_id: z.string().describe("The ID of the ticket to retrieve details for"),
    },
    async ({ ticket_id }) => {
      try {
        const result = await getTicketDetails(client, parseInt(ticket_id, 10));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_get_ticket_details_clean",
    "Get a Zendesk ticket and its comments with HTML stripped from comment bodies (links and image URLs preserved inline). Returns a token-efficient shape suitable for LLM consumption.",
    {
      ticket_id: z.string().describe("The ID of the ticket to retrieve details for"),
    },
    async ({ ticket_id }) => {
      try {
        const result = await getTicketDetailsClean(client, parseInt(ticket_id, 10));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "zendesk_get_linked_incidents",
    "Fetch all incident tickets linked to a particular ticket",
    {
      ticket_id: z.string().describe("The ID of the ticket to retrieve linked incidents for"),
    },
    async ({ ticket_id }) => {
      try {
        const result = await getLinkedIncidents(client, parseInt(ticket_id, 10));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }],
          isError: true
        };
      }
    }
  );
}