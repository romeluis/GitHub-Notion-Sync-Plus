# GitHub-Notion Sync Plus

A Node.js application that synchronizes Notion databases with GitHub issues, specifically designed to manage bug tracking workflows between both platforms.

## 🌟 Features

- **Bi-directional Sync**: Synchronize bug status changes between Notion and GitHub
- **Automatic Issue Creation**: Create GitHub issues from Notion bugs with proper formatting
- **Issue Link Population**: Automatically populate Notion's Issue Link field with GitHub URLs
- **Smart Status Mapping**: Map Notion status fields to GitHub issue states
- **Repository Routing**: Route bugs to different repositories based on module selection
- **Comprehensive Logging**: Detailed logging for all sync operations
- **Dry Run Mode**: Test sync operations without making actual changes
- **Error Handling**: Robust error handling with graceful degradation

## 📋 Prerequisites

- Node.js 18+ 
- Notion API token with database access
- GitHub personal access token with `issues:write` permission
- Access to target GitHub repositories

## 🚀 Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd GitHub-Notion-Sync-Plus
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your tokens and configuration
```

## ⚙️ Configuration

Create a `.env` file with the following variables:

```env
NOTION_TOKEN=your_notion_integration_token
GITHUB_TOKEN=your_github_personal_access_token
BUG_DATABASE_ID=your_notion_database_id
MODULE_MAPPING={"Application":"owner/app-repo","Firmware":"owner/firmware-repo"}
```

### Notion Database Schema

Your Notion bugs database should have the following properties:

| Property | Type | Description |
|----------|------|-------------|
| ID | Unique ID | Auto-generated bug ID (e.g., CBUG-1) |
| Bug Title | Title | Title of the bug |
| Status | Status | Bug status (Reported, Blocked, In Progress, In Review, Rejected, Fixed) |
| Type | Select | Bug type (Functionality, Fatal, Cosmetic) |
| Description | Rich Text | Detailed bug description |
| Steps to Reproduce | Rich Text | Steps to reproduce the bug |
| Module | Select | Target repository (Application, Firmware, etc.) |
| Issue Link | URL | Direct link to GitHub issue (automatically populated) |

## 🎯 Usage

### Dry Run (Recommended First)

Test what changes would be made without actually executing them:

```bash
npm run sync dry-run
# or
node src/index.js dry-run
```

### Full Synchronization

Perform actual synchronization:

```bash
npm start
# or
node src/index.js
```

### Available Scripts

- `npm start` - Run full synchronization
- `npm run dev` - Run with file watching for development
- `npm run sync` - Alias for start command
- `npm run dry-run` - Test what changes would be made without executing them

## 🔄 Sync Rules

### Notion to GitHub
- **New Bug**: Creates corresponding GitHub issue and populates Issue Link field in Notion
- **Status "Fixed"**: Closes GitHub issue
- **Bug Deleted**: Closes GitHub issue with explanation

### GitHub to Notion
- **Issue Closed**: Updates Notion bug status to "Fixed"
- **Issue Reopened**: Updates Notion bug status to "Reported"
- **Missing Issue Link**: Populates Issue Link field with GitHub issue URL

## 📝 GitHub Issue Format

Issues are created with the following format:

**Title**: `[Type]/[ID] [Bug Title]`  
Example: `[Fatal]/CBUG-1 Application crashes on startup`

**Body**:
```markdown
## Description
[Bug description from Notion]

## Steps to Reproduce
[Steps to reproduce from Notion]

## Bug Information
- **Type**: Fatal
- **Module**: Application
- **Status**: Reported

---
*This issue was automatically created from Notion bug CBUG-1*
```

**Labels**: `bug`, `notion-sync`, `[type]`, `[status-based-labels]`

## 🏗️ Architecture

```
src/
├── index.js           # Main application entry point
├── NotionClient.js    # Notion API interactions
├── GitHubClient.js    # GitHub API interactions
├── SyncManager.js     # Sync orchestration logic
├── DataMapper.js      # Data format mapping utilities
├── ConfigManager.js   # Configuration management
└── Logger.js          # Centralized logging system
```

## 🧪 Testing

Use the built-in dry run mode to test the application:

```bash
# Test what changes would be made
npm run dry-run

# Run actual synchronization
npm start
```

## 🛠️ Development

### Adding New Repositories

Update your `MODULE_MAPPING` environment variable:

```json
{
  "Application": "owner/app-repo",
  "Firmware": "owner/firmware-repo",
  "Documentation": "owner/docs-repo"
}
```

### Custom Status Mappings

Modify the status mapping in `src/DataMapper.js`:

```javascript
mapNotionStatusToGitHubState(notionStatus) {
    const statusMapping = {
        'Reported': 'open',
        'In Progress': 'open',
        'Fixed': 'closed',
        'Won\'t Fix': 'closed'
    };
    return statusMapping[notionStatus] || 'open';
}
```

## 📊 Logging

The application provides comprehensive logging with different levels:

- **INFO**: General operation information
- **WARN**: Warning messages for non-critical issues
- **ERROR**: Error messages with stack traces
- **DEBUG**: Detailed debug information (set `DEBUG=true`)

## 🚨 Error Handling

The application handles various error scenarios:

- Repository access issues
- Invalid Notion data
- GitHub API rate limits
- Network connectivity problems
- Authentication failures

## 🔐 Security

- Store sensitive tokens in environment variables
- Use GitHub fine-grained personal access tokens when possible
- Regularly rotate API tokens
- Monitor token usage and permissions

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For issues and questions:

1. Check the logs for detailed error information
2. Verify your environment configuration
3. Test with dry-run mode first
4. Open an issue with detailed reproduction steps

## 🚀 Future Enhancements

- [ ] Webhook integration for real-time sync
- [ ] Automatic branch creation for new issues
- [ ] Support for multiple Notion databases
- [ ] Advanced filtering and sync rules
- [ ] Web dashboard for monitoring sync status
- [ ] Slack/Discord notifications for sync events
