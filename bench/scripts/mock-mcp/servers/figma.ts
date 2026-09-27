/**
 * Vendored representative tool definitions for the Figma Dev Mode MCP server
 * surface. Used by the benchmark mock MCP server to reproduce realistic
 * tool-definition context overhead; the tools are never implemented.
 */
import { tool, type Tool } from '../tool.js';

export const figmaTools: Tool[] = [
  tool(
    'get_design_context',
    'Returns a code-ready representation of a Figma node, including layout, styles, and text content. This is the primary tool for generating code from a design. Provide the file key and node id from a Figma URL.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      clientLanguages: { type: 'string', description: 'Languages used in the client.' },
      clientFrameworks: { type: 'string', description: 'Frameworks used in the client.' },
      forceCode: { type: 'boolean', description: 'Force code output.' },
      disableCodeConnect: { type: 'boolean', description: 'Skip Code Connect hints.' },
      excludeScreenshot: { type: 'boolean', description: 'Omit the screenshot.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'get_screenshot',
    'Captures a PNG screenshot of a Figma node. Use it to visually verify a design or compare it against an implementation. Set contentsOnly to render just the node without its background.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      contentsOnly: { type: 'boolean', description: 'Render node without background.' },
      enableBase64Response: { type: 'boolean', description: 'Return image as base64.' },
      maxDimension: { type: 'number', description: 'Maximum image dimension in pixels.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'get_metadata',
    'Returns lightweight metadata for a Figma node and its children. Includes node ids, names, types, and bounding boxes without style or layout detail. Use it to plan which nodes to inspect next.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'get_variable_defs',
    'Returns the design variables and styles applied to a Figma node. Includes colors, typography, spacing, and effect tokens with their resolved values. Use it to map design tokens to code constants.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'get_code_connect_map',
    'Returns the Code Connect mappings for a Figma node. Each mapping links a node or component to a code component and import path. Use it to reuse existing components instead of generating new ones.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      codeConnectLabel: { type: 'string', description: 'Filter by Code Connect label.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'add_code_connect_map',
    'Creates a Code Connect mapping between a Figma node and a code component. Provide the source file, component name, and optional template. Returns the created mapping for later verification.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      source: { type: 'string', description: 'Path to the source file.' },
      componentName: { type: 'string', description: 'Name of the code component.' },
      label: { type: 'string', description: 'Code Connect label.' },
      template: { type: 'string', description: 'Template for the mapping.' },
      templateDataJson: { type: 'string', description: 'Template data as JSON.' },
    },
    ['nodeId', 'fileKey', 'source', 'componentName'],
  ),
  tool(
    'get_code_connect_suggestions',
    'Suggests Code Connect mappings for the components used in a Figma node. Suggestions are based on names, properties, and nearby mappings. Use it to bootstrap Code Connect for a new design system.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      excludeMappingPrompt: { type: 'boolean', description: 'Omit the mapping prompt.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'send_code_connect_mappings',
    'Saves a batch of Code Connect mappings for a Figma file. Mappings are validated before they are written. Returns the accepted mappings and any conflicts with existing entries.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      clientLanguages: { type: 'string', description: 'Languages used in the client.' },
      clientFrameworks: { type: 'string', description: 'Frameworks used in the client.' },
      mappings: { type: 'array', description: 'Mappings to save.' },
    },
    ['nodeId', 'fileKey', 'mappings'],
  ),
  tool(
    'create_design_system_rules',
    'Generates design system rules for a target codebase from the current Figma file. Rules describe component conventions, tokens, and layout patterns. Use the returned rules as project instructions for code generation.',
    {
      clientLanguages: { type: 'string', description: 'Languages used in the client.' },
      clientFrameworks: { type: 'string', description: 'Frameworks used in the client.' },
    },
    ['clientLanguages', 'clientFrameworks'],
  ),
  tool(
    'generate_figma_design',
    'Generates a Figma design from a captured web page or application screen. Provide the file key to write into and an optional node id to replace. Returns the created frames and a capture id for follow-up edits.',
    {
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      captureId: { type: 'string', description: 'Capture id to generate from.' },
    },
    ['fileKey'],
  ),
  tool(
    'get_figjam',
    'Returns the contents of a FigJam board, including stickies, shapes, connectors, and text. Set includeImagesOfNodes to embed node images in the response. Use it to summarize workshop output or convert it into tasks.',
    {
      nodeId: { type: 'string', description: 'Figma node id, e.g. 12:34.' },
      fileKey: { type: 'string', description: 'Figma file key from the URL.' },
      includeImagesOfNodes: { type: 'boolean', description: 'Embed node images.' },
    },
    ['nodeId', 'fileKey'],
  ),
  tool(
    'whoami',
    'Returns the identity of the authenticated Figma user. Includes the user id, handle, and email address. Use it to confirm which account and seat is connected.',
    {},
  ),
];
