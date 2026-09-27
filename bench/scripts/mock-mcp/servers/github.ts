/**
 * Vendored representative tool definitions for the official GitHub MCP server
 * surface. Used by the benchmark mock MCP server to reproduce realistic
 * tool-definition context overhead; the tools are never implemented.
 */
import { tool, type Tool } from '../tool.js';

export const githubTools: Tool[] = [
  tool(
    'get_me',
    'Get details of the authenticated GitHub user. Returns the login, name, email, avatar URL, and plan information. Use this to confirm which account the server is acting as.',
    {},
  ),
  tool(
    'search_repositories',
    'Search for GitHub repositories by name, description, topics, or README content. Supports qualifiers such as language, stars, and owner in the query string. Returns repositories with metadata and pagination cursors.',
    {
      query: { type: 'string', description: 'Search query string.' },
      sort: { type: 'string', description: 'Sort field for results.' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
      page: { type: 'number', description: 'Page number of results.' },
    },
    ['query'],
  ),
  tool(
    'get_file_contents',
    'Get the contents of a file or directory in a GitHub repository. Returns Base64-encoded content for files and a listing for directories. Specify a branch, tag, or commit in ref to read a specific revision.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      path: { type: 'string', description: 'Path to the file or directory.' },
      ref: { type: 'string', description: 'Branch, tag, or commit sha.' },
    },
    ['owner', 'repo', 'path'],
  ),
  tool(
    'create_or_update_file',
    'Create a new file or update an existing one in a GitHub repository. Provide the new content, a commit message, and the target branch. When updating, include the blob sha of the current file to avoid conflicts.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      path: { type: 'string', description: 'Path to the file.' },
      content: { type: 'string', description: 'File content to commit.' },
      message: { type: 'string', description: 'Commit message.' },
      branch: { type: 'string', description: 'Target branch name.' },
      sha: { type: 'string', description: 'Blob sha of the file being replaced.' },
    },
    ['owner', 'repo', 'path', 'content', 'message', 'branch'],
  ),
  tool(
    'push_files',
    'Push multiple file changes to a GitHub repository in a single commit. Each file entry specifies a path and its full content. Use this for atomic multi-file edits on the same branch.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      branch: { type: 'string', description: 'Target branch name.' },
      files: { type: 'array', description: 'Files to push with path and content.' },
      message: { type: 'string', description: 'Commit message.' },
    },
    ['owner', 'repo', 'branch', 'files', 'message'],
  ),
  tool(
    'create_branch',
    'Create a new branch in a GitHub repository. The branch is created from the default branch unless from_branch is provided. Returns the ref and commit sha of the new branch.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      branch: { type: 'string', description: 'Name of the new branch.' },
      from_branch: { type: 'string', description: 'Branch to branch from.' },
    },
    ['owner', 'repo', 'branch'],
  ),
  tool(
    'list_branches',
    'List branches in a GitHub repository, sorted alphabetically. Supports pagination through page and per_page. Returns branch names and their latest commit shas.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      page: { type: 'number', description: 'Page number of results.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'list_commits',
    'List commits on a branch or from a specific commit in a GitHub repository. Optionally filter by author or path, and paginate through the history. Returns commit messages, authors, and shas.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      sha: { type: 'string', description: 'Commit sha or branch to start from.' },
      author: { type: 'string', description: 'Filter commits by author.' },
      page: { type: 'number', description: 'Page number of results.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'get_commit',
    'Get a single commit from a GitHub repository by its sha or ref name. Optionally include the diff and the list of changed files. Returns commit metadata, parents, and stats.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      sha: { type: 'string', description: 'Commit sha or ref.' },
      include_diff: { type: 'boolean', description: 'Include the commit diff.' },
    },
    ['owner', 'repo', 'sha'],
  ),
  tool(
    'create_issue',
    'Create a new issue in a GitHub repository. Provide a title and optional body in Markdown, along with assignees, labels, and a milestone. Returns the created issue number and URL.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body in Markdown.' },
      assignees: { type: 'array', description: 'Logins to assign.' },
      labels: { type: 'array', description: 'Label names to apply.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a GitHub repository, filtered by state, labels, and update time. Results can be sorted and paginated, and pull requests are excluded. Returns issue titles, numbers, labels, and assignees.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      labels: { type: 'array', description: 'Label names to filter by.' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'update_issue',
    'Update an existing issue title, body, state, labels, or assignees. State changes accept open or closed with an optional reason. Returns the updated issue with its current state.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      issue_number: { type: 'number', description: 'Issue number.' },
      title: { type: 'string', description: 'New issue title.' },
      body: { type: 'string', description: 'New issue body in Markdown.' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'New issue state.' },
      labels: { type: 'array', description: 'Replacement label names.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'add_issue_comment',
    'Add a comment to an issue or pull request in a GitHub repository. The body is rendered as GitHub-flavored Markdown. Returns the created comment id and URL.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      issue_number: { type: 'number', description: 'Issue or pull request number.' },
      body: { type: 'string', description: 'Comment body in Markdown.' },
    },
    ['owner', 'repo', 'issue_number', 'body'],
  ),
  tool(
    'search_issues',
    'Search issues and pull requests across GitHub with a query string. Supports qualifiers such as repo, is, label, and author. Returns matching items with state, labels, and comment counts.',
    {
      query: { type: 'string', description: 'Search query string.' },
      sort: { type: 'string', description: 'Sort field for results.' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['query'],
  ),
  tool(
    'list_pull_requests',
    'List pull requests in a GitHub repository, filtered by state, head, and base branch. Results can be sorted by created, updated, popularity, or long-running. Returns pull request metadata and pagination links.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      head: { type: 'string', description: 'Filter by head branch.' },
      base: { type: 'string', description: 'Filter by base branch.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a new pull request in a GitHub repository. Specify the head branch with changes and the base branch to merge into. Returns the pull request number, URL, and merge status.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'Branch containing the changes.' },
      base: { type: 'string', description: 'Branch to merge into.' },
      body: { type: 'string', description: 'Pull request body in Markdown.' },
      draft: { type: 'boolean', description: 'Create as a draft.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'get_pull_request',
    'Get details of a single pull request by number. Returns the title, body, branches, mergeability, review status, and diff stats. Use get_pull_request_files for the changed files.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request into its base branch. Choose the merge method: merge, squash, or rebase. Optionally set a custom commit title and message for the merge commit.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      commit_title: { type: 'string', description: 'Title for the merge commit.' },
      merge_method: {
        type: 'string',
        enum: ['merge', 'squash', 'rebase'],
        description: 'Merge strategy.',
      },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'get_pull_request_files',
    'List the files changed by a pull request, with additions, deletions, and patch hunks. Results are paginated for large pull requests. Returns file paths, statuses, and diffs.',
    {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'search_code',
    'Search for code across GitHub repositories using a query string. Supports qualifiers such as repo, language, path, and filename. Returns matching file fragments with repository and path context.',
    {
      query: { type: 'string', description: 'Search query string.' },
      sort: { type: 'string', description: 'Sort field for results.' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
      per_page: { type: 'number', description: 'Results per page, max 100.' },
    },
    ['query'],
  ),
];
