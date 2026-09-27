/**
 * Vendored representative tool definitions for the Notion MCP server surface.
 * Used by the benchmark mock MCP server to reproduce realistic tool-definition
 * context overhead; the tools are never implemented.
 */
import { tool, type Tool } from '../tool.js';

export const notionTools: Tool[] = [
  tool(
    'notion-search',
    'Search across your Notion workspace by title or content. Returns matching pages, databases, and data sources with highlighted snippets and URLs. Use this to locate content before fetching it by id.',
    {
      query: { type: 'string', description: 'Search query text.' },
      query_type: {
        type: 'string',
        enum: ['internal', 'user'],
        description: 'Scope of the search.',
      },
      data_source_url: { type: 'string', description: 'URL of a data source to search.' },
      page_size: { type: 'number', description: 'Maximum results to return.' },
      filters: { type: 'object', description: 'Property filters for the search.' },
    },
    ['query'],
  ),
  tool(
    'notion-fetch',
    'Retrieves a Notion page, database, or data source by its id or URL. Returns the full content as Markdown, including child blocks, and optionally transcripts and discussions. Use the id returned by notion-search.',
    {
      id: { type: 'string', description: 'Page or database id or URL.' },
      include_transcript: { type: 'boolean', description: 'Include meeting transcripts.' },
      include_discussions: { type: 'boolean', description: 'Include discussion threads.' },
    },
    ['id'],
  ),
  tool(
    'notion-create-pages',
    'Creates one or more pages under a specified parent page or data source. Each page can define properties and initial Markdown content. Supports synchronous and asynchronous creation for large batches.',
    {
      pages: { type: 'array', description: 'Pages to create with properties and content.' },
      parent: { type: 'object', description: 'Parent page or data source reference.' },
      creation_mode: {
        type: 'string',
        enum: ['synchronous', 'asynchronous'],
        description: 'How pages are created.',
      },
      allow_async: { type: 'boolean', description: 'Allow asynchronous creation.' },
    },
    ['pages'],
  ),
  tool(
    'notion-update-page',
    'Updates a Notion page properties, content, or both. Content commands can replace the whole page, insert before, or insert after an existing block. Requires the page id returned by notion-search or notion-fetch.',
    {
      page_id: { type: 'string', description: 'Id of the page to update.' },
      command: {
        type: 'string',
        enum: ['replace_content', 'insert_after', 'insert_before'],
        description: 'How content is applied.',
      },
      properties: { type: 'object', description: 'Property values to set.' },
      content: { type: 'string', description: 'Markdown content to apply.' },
      new_str: { type: 'string', description: 'Replacement text for the command.' },
    },
    ['page_id'],
  ),
  tool(
    'notion-move-pages',
    'Moves one or more pages or databases to a new parent page or workspace. All items must share the same parent. Returns the moved items with their new parent references.',
    {
      page_or_database_ids: { type: 'array', description: 'Items to move.' },
      new_parent: { type: 'object', description: 'Destination parent reference.' },
    },
    ['page_or_database_ids', 'new_parent'],
  ),
  tool(
    'notion-duplicate-page',
    'Duplicates a Notion page, including its child blocks and property values. The copy is created in the same parent as the original. Returns the id and URL of the new page.',
    {
      page_id: { type: 'string', description: 'Id of the page to duplicate.' },
    },
    ['page_id'],
  ),
  tool(
    'notion-create-database',
    'Creates a new Notion database or data source with a defined schema. Properties must declare a name and a type such as title, rich_text, number, select, or date. Returns the created database and its data source id.',
    {
      parent: { type: 'object', description: 'Parent page for the database.' },
      title: { type: 'string', description: 'Database title.' },
      description: { type: 'string', description: 'Database description.' },
      schema: { type: 'object', description: 'Property definitions keyed by name.' },
      database_type: {
        type: 'string',
        enum: ['database', 'data_source'],
        description: 'Kind of container to create.',
      },
    },
    ['parent', 'title', 'schema'],
  ),
  tool(
    'notion-update-data-source',
    'Updates the title, description, inline flag, or schema of an existing data source. Schema statements add, rename, or remove properties and must be applied in order. Returns the updated data source.',
    {
      data_source_id: { type: 'string', description: 'Id of the data source.' },
      statements: { type: 'array', description: 'Schema statements to apply.' },
      title: { type: 'string', description: 'New data source title.' },
      description: { type: 'string', description: 'New description.' },
      is_inline: { type: 'boolean', description: 'Render inline in the parent page.' },
    },
    ['data_source_id'],
  ),
  tool(
    'notion-create-comment',
    'Adds a comment to a Notion page or an existing discussion thread. Provide rich_text blocks or Markdown content, and optionally anchor the comment to a text selection. Returns the created comment id.',
    {
      page_id: { type: 'string', description: 'Page to comment on.' },
      rich_text: { type: 'array', description: 'Comment body as rich text.' },
      markdown: { type: 'string', description: 'Comment body as Markdown.' },
      selection_with_ellipsis: { type: 'string', description: 'Anchor text selection.' },
    },
    ['page_id'],
  ),
  tool(
    'notion-get-comments',
    'Retrieves comments for a Notion page or a specific discussion thread. Resolved threads are excluded by default, and block metadata can be included. Returns comments in chronological order with author information.',
    {
      page_id: { type: 'string', description: 'Page whose comments to read.' },
      include_resolved: { type: 'boolean', description: 'Include resolved threads.' },
      include_all_blocks: { type: 'boolean', description: 'Include block metadata.' },
      discussion_id: { type: 'string', description: 'Discussion thread id.' },
    },
    ['page_id'],
  ),
  tool(
    'notion-get-users',
    'Lists workspace users, including guests and bots, with their ids, names, and avatars. Supports lookup by user id or by name and email query. Use the returned id to assign people to page properties.',
    {
      query: { type: 'string', description: 'Name or email to match.' },
      user_id: { type: 'string', description: 'Id of a single user.' },
      page_size: { type: 'number', description: 'Maximum users to return.' },
      start_cursor: { type: 'string', description: 'Pagination cursor.' },
    },
  ),
  tool(
    'notion-get-teams',
    'Lists the teams available in the current Notion workspace. Each team includes its id, name, and description. Use the id when granting a team access to a page or database.',
    {
      query: { type: 'string', description: 'Name to match.' },
      page_size: { type: 'number', description: 'Maximum teams to return.' },
      start_cursor: { type: 'string', description: 'Pagination cursor.' },
    },
  ),
];
