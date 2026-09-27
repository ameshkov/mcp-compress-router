/**
 * Vendored representative tool definitions for the Playwright MCP server
 * surface. Used by the benchmark mock MCP server to reproduce realistic
 * tool-definition context overhead; the tools are never implemented.
 */
import { tool, type Tool } from '../tool.js';

export const playwrightTools: Tool[] = [
  tool(
    'browser_navigate',
    'Navigate the current tab to a URL. Waits for the page load event before returning. Use it as the first step of any browser interaction.',
    {
      url: { type: 'string', description: 'URL to navigate to.' },
    },
    ['url'],
  ),
  tool(
    'browser_navigate_back',
    'Go back to the previous page in the current tab. Equivalent to pressing the browser back button. Fails when there is no history entry to return to.',
    {},
  ),
  tool(
    'browser_click',
    'Click an element on the page. Use a snapshot to obtain the element ref, or pass a CSS selector. Supports double clicks, alternate mouse buttons, and modifier keys.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button to click.',
      },
      doubleClick: { type: 'boolean', description: 'Perform a double click.' },
      modifiers: { type: 'array', description: 'Modifier keys to hold.' },
    },
    ['element'],
  ),
  tool(
    'browser_type',
    'Type text into an editable element. Use a snapshot to obtain the element ref, or pass a CSS selector. Set submit to press Enter after typing, or slowly to type key by key.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
      text: { type: 'string', description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      slowly: { type: 'boolean', description: 'Type one key at a time.' },
    },
    ['element', 'text'],
  ),
  tool(
    'browser_fill_form',
    'Fill multiple form fields in one call. Each field specifies its name, type, and value, and can target a ref or a selector. Supports text inputs, checkboxes, radio buttons, and comboboxes.',
    {
      fields: { type: 'array', description: 'Form fields to fill.' },
    },
    ['fields'],
  ),
  tool(
    'browser_press_key',
    'Press a key on the keyboard in the current page. Accepts key names such as ArrowLeft or Enter, or a single character. Use it for shortcuts and keyboard navigation.',
    {
      key: { type: 'string', description: 'Key name, e.g. Enter.' },
    },
    ['key'],
  ),
  tool(
    'browser_hover',
    'Move the mouse over an element on the page. Triggers hover styles and hover-only menus. Use a snapshot to obtain the element ref, or pass a CSS selector.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
    },
    ['element'],
  ),
  tool(
    'browser_select_option',
    'Select one or more options in a dropdown. Values are matched against option values or labels. Use a snapshot to obtain the element ref, or pass a CSS selector.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
      values: { type: 'array', description: 'Values to select.' },
    },
    ['element', 'values'],
  ),
  tool(
    'browser_take_screenshot',
    'Take a screenshot of the current page or a single element. Screenshots are saved as PNG or JPEG and returned as an image. Set fullPage to capture the entire scrollable page.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
      type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format.' },
      filename: { type: 'string', description: 'File name for the saved image.' },
      fullPage: { type: 'boolean', description: 'Capture the full page.' },
      scale: { type: 'string', enum: ['css', 'device'], description: 'Scale of the screenshot.' },
    },
  ),
  tool(
    'browser_snapshot',
    'Capture an accessibility snapshot of the current page. Returns a structured text tree with element refs that other tools can target. Prefer it over screenshots when you need to interact with the page.',
    {
      target: { type: 'string', description: 'Target element or page.' },
      depth: { type: 'number', description: 'Depth of the snapshot tree.' },
      boxes: { type: 'boolean', description: 'Include bounding boxes.' },
    },
  ),
  tool(
    'browser_evaluate',
    'Evaluate a JavaScript function in the page context and return its result. The function runs in the browser, so it can read and modify the DOM. Pass a ref or selector to scope the call to one element.',
    {
      element: { type: 'string', description: 'Human-readable element description.' },
      ref: { type: 'string', description: 'Element reference from a snapshot.' },
      function: { type: 'string', description: 'Function to evaluate in the page.' },
      filename: { type: 'string', description: 'File containing the function.' },
    },
    ['function'],
  ),
  tool(
    'browser_wait_for',
    'Wait for a specified time or for text to appear or disappear on the page. At least one condition must be provided. Useful for pages that render asynchronously.',
    {
      time: { type: 'number', description: 'Seconds to wait.' },
      text: { type: 'string', description: 'Text that should appear.' },
      textGone: { type: 'string', description: 'Text that should disappear.' },
    },
  ),
  tool(
    'browser_file_upload',
    'Upload one or more files to a file input on the page. Paths must point to files the server can read. The input must be visible or made visible by the upload action.',
    {
      paths: { type: 'array', description: 'File paths to upload.' },
    },
    ['paths'],
  ),
  tool(
    'browser_tabs',
    'List, create, close, or select browser tabs. Use the action parameter to choose the operation and index to target a tab. Selecting a tab makes it the target of subsequent calls.',
    {
      action: {
        type: 'string',
        enum: ['list', 'new', 'close', 'select'],
        description: 'Tab operation to perform.',
      },
      index: { type: 'number', description: 'Zero-based tab index.' },
      url: { type: 'string', description: 'URL to open in a new tab.' },
    },
    ['action'],
  ),
  tool(
    'browser_close',
    'Close the current browser page and release its resources. Call it when a browser session is no longer needed. The browser is relaunched automatically on the next navigation.',
    {},
  ),
];
