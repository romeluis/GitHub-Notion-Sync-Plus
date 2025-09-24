 const express = require('express');
const cors = require('cors');

/**
 * WebhookHandler manages Notion webhook actions for branch creation
 * Handles both Bug and Task database webhooks when buttons are pressed
 */
class WebhookHandler {
    constructor(config, githubClient, notionClient, logger) {
        this.config = config;
        this.github = githubClient;
        this.notion = notionClient;
        this.logger = logger;
        this.app = express();
        this.server = null;
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Enable CORS for webhook endpoint - allow all origins for development
        this.app.use(cors({
            origin: true,
            methods: ['POST', 'GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: true
        }));

        // Parse JSON bodies
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
            this.logger.info(`${req.method} ${req.path}`, {
                userAgent: req.get('User-Agent'),
                contentType: req.get('Content-Type'),
                ip: req.ip || req.connection.remoteAddress
            });
            next();
        });
    }

    /**
     * Setup Express routes
     */
    setupRoutes() {
        // Main webhook endpoint for Notion webhook actions
        this.app.post('/webhook/notion', this.handleNotionWebhook.bind(this));
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                service: 'GitHub-Notion Sync Plus',
                webhook: 'active',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '1.0.0'
            });
        });

        // Root endpoint with instructions
        this.app.get('/', (req, res) => {
            res.json({
                service: 'GitHub-Notion Sync Plus Webhook Server',
                status: 'running',
                timestamp: new Date().toISOString(),
                endpoints: {
                    webhook: 'POST /webhook/notion',
                    health: 'GET /health',
                    test: 'POST /webhook/test'
                },
                webhookUrl: `https://capstonesync.romeluis.com/webhook/notion`,
                tunnelUrl: `http://localhost:3000`,
                uptime: process.uptime()
            });
        });

        // Test endpoint for webhook testing
        this.app.post('/webhook/test', (req, res) => {
            this.logger.info('Test webhook received', { 
                body: req.body,
                headers: {
                    'content-type': req.get('Content-Type'),
                    'user-agent': req.get('User-Agent')
                },
                query: req.query
            });
            res.json({
                status: 'received',
                message: 'Test webhook processed successfully',
                receivedData: req.body,
                timestamp: new Date().toISOString()
            });
        });
    }

    /**
     * Handle incoming Notion webhook actions
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleNotionWebhook(req, res) {
        try {
            this.logger.info('Received Notion webhook action', { 
                body: req.body,
                headers: {
                    'content-type': req.get('Content-Type'),
                    'user-agent': req.get('User-Agent'),
                    'content-length': req.get('Content-Length')
                },
                method: req.method,
                url: req.url,
                bodyType: typeof req.body,
                bodyKeys: req.body ? Object.keys(req.body) : [],
                // Log the actual properties structure
                fullProperties: req.body?.data?.properties ? JSON.stringify(req.body.data.properties, null, 2) : 'No properties'
            });

            // Validate request has body
            if (!req.body || Object.keys(req.body).length === 0) {
                this.logger.warn('Received webhook with empty body');
                return res.status(400).json({ 
                    error: 'Empty webhook payload',
                    message: 'Webhook body is required'
                });
            }

            // Process webhook synchronously to return proper error responses
            try {
                const result = await this.processWebhook(req.body, req.headers);
                
                if (result.success) {
                    res.status(200).json({ 
                        status: 'success', 
                        timestamp: new Date().toISOString(),
                        message: result.message,
                        branchUrl: result.branchUrl
                    });
                } else {
                    res.status(400).json({ 
                        status: 'error', 
                        timestamp: new Date().toISOString(),
                        error: result.error,
                        message: result.message
                    });
                }
            } catch (error) {
                this.logger.error('Error processing webhook:', error);
                res.status(500).json({ 
                    status: 'error',
                    error: 'Webhook processing failed',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }

        } catch (error) {
            this.logger.error('Error handling webhook:', error);
            
            // Only respond if headers haven't been sent
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Webhook processing failed',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * Process webhook data synchronously with error handling
     * @param {Object} webhookData - Notion webhook action data
     * @param {Object} headers - Request headers
     * @returns {Object} Result object with success/error status
     */
    async processWebhook(webhookData, headers = {}) {
        try {
            this.logger.info('Processing webhook action', { 
                webhookData,
                userAgent: headers['user-agent'],
                contentType: headers['content-type']
            });

            // Check if this is a branch creation action
            if (!this.isBranchCreationAction(webhookData) && !this.isPullRequestCreationAction(webhookData) && !this.isMergeChangesAction(webhookData)) {
                const availableFields = Object.keys(webhookData || {});
                this.logger.info('Webhook action not recognized', {
                    reason: 'Missing required fields',
                    availableFields
                });
                return {
                    success: false,
                    error: 'INVALID_WEBHOOK',
                    message: `Webhook does not contain required fields for any supported action. Available fields: ${availableFields.join(', ')}`
                };
            }

            // Determine which action to take based on priority
            // Note: This is a simplified detection - in practice, you might want to add
            // a specific field or parameter to distinguish between PR creation and merge
            if (this.isMergeChangesAction(webhookData)) {
                this.logger.info('Webhook identified as merge changes action');
                return await this.mergeChangesFromWebhook(webhookData);
            } else if (this.isPullRequestCreationAction(webhookData)) {
                this.logger.info('Webhook identified as pull request creation action');
                return await this.createPullRequestFromWebhook(webhookData);
            } else {
                this.logger.info('Webhook identified as branch creation action');
                return await this.createBranchFromWebhook(webhookData);
            }

        } catch (error) {
            this.logger.error('Error processing webhook:', error);
            return {
                success: false,
                error: 'PROCESSING_ERROR',
                message: `Failed to process webhook: ${error.message}`
            };
        }
    }

    /**
     * Process webhook data asynchronously (deprecated - kept for backward compatibility)
     * @param {Object} webhookData - Notion webhook action data
     * @param {Object} headers - Request headers
     */
    async processWebhookAsync(webhookData, headers = {}) {
        const result = await this.processWebhook(webhookData, headers);
        if (!result.success) {
            this.logger.error('Async webhook processing failed:', result);
        }
    }

    /**
     * Check if webhook action is for branch creation
     * @param {Object} webhookData - Webhook payload
     * @returns {boolean} True if this is a branch creation action
     */
    isBranchCreationAction(webhookData) {
        // Notion webhook data structure: { source: {...}, data: { properties: {...} } }
        const pageData = webhookData.data;
        
        this.logger.info('Analyzing webhook payload structure', { 
            keys: Object.keys(webhookData || {}),
            dataKeys: pageData ? Object.keys(pageData) : [],
            properties: pageData?.properties || null,
            availableProperties: pageData?.properties ? Object.keys(pageData.properties) : []
        });

        if (!pageData || !pageData.properties) {
            this.logger.info('No page data or properties found in webhook');
            return false;
        }

        // Use the proper extraction methods
        const title = this.extractTitle(webhookData);
        const id = this.extractId(webhookData);
        const module = this.extractModule(webhookData);
        
        this.logger.info('Webhook property analysis', {
            hasTitle: !!title,
            hasId: !!id,
            hasModule: !!module,
            titleValue: title,
            idValue: id,
            moduleValue: module,
            availableProperties: Object.keys(pageData.properties)
        });

        return !!(title && id);
    }

    /**
     * Check if webhook action is for pull request creation
     * @param {Object} webhookData - Webhook payload
     * @returns {boolean} True if this is a PR creation action
     */
    isPullRequestCreationAction(webhookData) {
        const pageData = webhookData.data;
        
        if (!pageData || !pageData.properties) {
            this.logger.info('No page data or properties found in webhook for PR creation');
            return false;
        }

        const title = this.extractTitle(webhookData);
        const id = this.extractId(webhookData);
        const branchUrl = this.extractBranchUrl(webhookData);
        
        this.logger.info('PR webhook property analysis', {
            hasTitle: !!title,
            hasId: !!id,
            hasBranchUrl: !!branchUrl,
            titleValue: title,
            idValue: id,
            branchUrlValue: branchUrl
        });

        // Need title, id, and branch URL to create PR
        return !!(title && id && branchUrl);
    }

    /**
     * Check if webhook action is for merging changes
     * @param {Object} webhookData - Webhook payload
     * @returns {boolean} True if this is a merge action
     */
    isMergeChangesAction(webhookData) {
        const pageData = webhookData.data;
        
        if (!pageData || !pageData.properties) {
            this.logger.info('No page data or properties found in webhook for merge action');
            return false;
        }

        const title = this.extractTitle(webhookData);
        const id = this.extractId(webhookData);
        const branchUrl = this.extractBranchUrl(webhookData);
        
        this.logger.info('Merge webhook property analysis', {
            hasTitle: !!title,
            hasId: !!id,
            hasBranchUrl: !!branchUrl,
            titleValue: title,
            idValue: id,
            branchUrlValue: branchUrl
        });

        // Need title, id, and branch URL to merge changes
        return !!(title && id && branchUrl);
    }

    /**
     * Create a branch based on webhook data
     * @param {Object} webhookData - Contains database properties from Notion
     * @returns {Object} Result object with success/error status
     */
    async createBranchFromWebhook(webhookData) {
        try {
            // Extract data from webhook payload (Notion database properties)
            const title = this.extractTitle(webhookData);
            const id = this.extractId(webhookData);
            const module = this.extractModule(webhookData);
            const type = this.extractType(webhookData);
            const pageId = this.extractPageId(webhookData);
            
            this.logger.info('Creating branch from webhook data', {
                id, title, module, type, pageId, rawData: webhookData
            });

            if (!title || !id) {
                return {
                    success: false,
                    error: 'MISSING_REQUIRED_FIELDS',
                    message: `Missing required fields - Title: ${title}, ID: ${id}`
                };
            }

            if (!pageId) {
                return {
                    success: false,
                    error: 'MISSING_PAGE_ID',
                    message: 'Cannot update Notion without page ID'
                };
            }

            // Get repository from module mapping
            const repository = this.getRepositoryFromModule(module);
            if (!repository) {
                return {
                    success: false,
                    error: 'UNKNOWN_MODULE',
                    message: `Unknown module: ${module}. Cannot determine target repository.`
                };
            }

            // Generate branch name using same format as issues: [type]/ID-title
            const branchName = this.generateBranchName(id, title, type);

            // Create branch from main
            const branchResult = await this.github.createBranch(repository, branchName, 'main');
            
            if (!branchResult) {
                return {
                    success: false,
                    error: 'BRANCH_EXISTS',
                    message: `Branch ${branchName} already exists in ${repository}`
                };
            }

            this.logger.info('Successfully created branch', {
                repository,
                branchName,
                branchUrl: branchResult.url
            });

            // Update Notion with branch link
            const notionUpdatePromise = this.updateNotionWithBranchLink(pageId, branchResult.url, id);
            
            // Try to update the corresponding GitHub issue with branch link (if it exists)
            const githubUpdatePromise = this.updateGitHubIssueWithBranchLink(id, repository, branchResult.url, branchResult.name);

            const [notionResult, githubResult] = await Promise.allSettled([
                notionUpdatePromise,
                githubUpdatePromise
            ]);

            let message = `Successfully created branch ${branchName}`;
            let warnings = [];

            // Check Notion update result
            if (notionResult.status === 'rejected') {
                this.logger.error('Failed to update Notion with branch link:', notionResult.reason);
                warnings.push(`Notion update failed: ${notionResult.reason.message}`);
            } else {
                message += ' and updated Notion';
            }

            // Check GitHub issue update result
            if (githubResult.status === 'rejected') {
                this.logger.warn('Failed to update GitHub issue with branch link:', githubResult.reason);
                if (githubResult.reason.message !== 'ISSUE_NOT_FOUND') {
                    warnings.push(`GitHub issue update failed: ${githubResult.reason.message}`);
                } else {
                    this.logger.info(`GitHub issue for ${id} doesn't exist yet - will be updated during next sync cycle`);
                }
            } else {
                message += ' and GitHub issue';
            }

            return {
                success: true,
                message: message,
                branchUrl: branchResult.url,
                branchName,
                repository,
                warnings: warnings.length > 0 ? warnings : undefined
            };

        } catch (error) {
            this.logger.error('Error creating branch from webhook:', error);
            return {
                success: false,
                error: 'BRANCH_CREATION_FAILED',
                message: `Failed to create branch: ${error.message}`
            };
        }
    }

    /**
     * Create a pull request based on webhook data
     * @param {Object} webhookData - Contains database properties from Notion
     * @returns {Object} Result object with success/error status
     */
    async createPullRequestFromWebhook(webhookData) {
        try {
            // Extract data from webhook payload
            const title = this.extractTitle(webhookData);
            const id = this.extractId(webhookData);
            const module = this.extractModule(webhookData);
            const type = this.extractType(webhookData);
            const pageId = this.extractPageId(webhookData);
            const branchUrl = this.extractBranchUrl(webhookData);
            const description = this.extractDescription(webhookData);
            
            this.logger.info('Creating pull request from webhook data', {
                id, title, module, type, pageId, branchUrl, description
            });

            if (!title || !id || !branchUrl) {
                return {
                    success: false,
                    error: 'MISSING_REQUIRED_FIELDS',
                    message: `Missing required fields - Title: ${!!title}, ID: ${!!id}, Branch URL: ${!!branchUrl}`
                };
            }

            if (!pageId) {
                return {
                    success: false,
                    error: 'MISSING_PAGE_ID',
                    message: 'Cannot update Notion without page ID'
                };
            }

            // Parse branch URL to get repository and branch name
            const branchInfo = this.parseBranchUrl(branchUrl);
            if (!branchInfo) {
                return {
                    success: false,
                    error: 'INVALID_BRANCH_URL',
                    message: `Could not parse branch URL: ${branchUrl}`
                };
            }

            const { repository, branchName } = branchInfo;

            // Check if branch exists and has changes
            const branchStatus = await this.checkBranchStatus(repository, branchName);
            if (!branchStatus.exists) {
                return {
                    success: false,
                    error: 'BRANCH_NOT_FOUND',
                    message: `Branch ${branchName} does not exist in ${repository}`
                };
            }

            if (!branchStatus.hasChanges) {
                return {
                    success: false,
                    error: 'NO_CHANGES',
                    message: `Branch ${branchName} has no changes compared to main`
                };
            }

            // Check if PR already exists for this branch
            const existingPR = await this.findExistingPR(repository, branchName);
            if (existingPR) {
                return {
                    success: false,
                    error: 'PR_ALREADY_EXISTS',
                    message: `Pull request already exists for branch ${branchName}: ${existingPR.githubUrl}`
                };
            }

            // Create the pull request
            const prTitle = this.generatePRTitle(id, title, type);
            const prBody = this.generatePRBody(description, id, type);
            
            const pullRequest = await this.github.createPullRequest(
                repository, 
                branchName, 
                'main', 
                prTitle, 
                prBody
            );

            this.logger.info('Successfully created pull request', {
                repository,
                branchName,
                prNumber: pullRequest.githubId,
                prUrl: pullRequest.githubUrl
            });

            // Update Notion with PR information
            await this.updateNotionWithPRInfo(pageId, id, pullRequest.githubUrl, 'Open');

            return {
                success: true,
                message: `Successfully created pull request #${pullRequest.githubId}`,
                pullRequestUrl: pullRequest.githubUrl,
                pullRequestNumber: pullRequest.githubId,
                branchName,
                repository
            };

        } catch (error) {
            this.logger.error('Error creating pull request from webhook:', error);
            return {
                success: false,
                error: 'PR_CREATION_FAILED',
                message: `Failed to create pull request: ${error.message}`
            };
        }
    }

    /**
     * Merge changes from branch - create PR if needed, then merge
     * @param {Object} webhookData - Contains database properties from Notion
     * @returns {Object} Result object with success/error status
     */
    async mergeChangesFromWebhook(webhookData) {
        try {
            // Extract data from webhook payload
            const title = this.extractTitle(webhookData);
            const id = this.extractId(webhookData);
            const module = this.extractModule(webhookData);
            const type = this.extractType(webhookData);
            const pageId = this.extractPageId(webhookData);
            const branchUrl = this.extractBranchUrl(webhookData);
            const description = this.extractDescription(webhookData);
            
            this.logger.info('Merging changes from webhook data', {
                id, title, module, type, pageId, branchUrl, description
            });

            if (!title || !id || !branchUrl) {
                return {
                    success: false,
                    error: 'MISSING_REQUIRED_FIELDS',
                    message: `Missing required fields - Title: ${!!title}, ID: ${!!id}, Branch URL: ${!!branchUrl}`
                };
            }

            if (!pageId) {
                return {
                    success: false,
                    error: 'MISSING_PAGE_ID',
                    message: 'Cannot update Notion without page ID'
                };
            }

            // Parse branch URL to get repository and branch name
            const branchInfo = this.parseBranchUrl(branchUrl);
            if (!branchInfo) {
                return {
                    success: false,
                    error: 'INVALID_BRANCH_URL',
                    message: `Could not parse branch URL: ${branchUrl}`
                };
            }

            const { repository, branchName } = branchInfo;

            // Check if branch exists and has changes
            const branchStatus = await this.checkBranchStatus(repository, branchName);
            if (!branchStatus.exists) {
                return {
                    success: false,
                    error: 'BRANCH_NOT_FOUND',
                    message: `Branch ${branchName} does not exist in ${repository}`
                };
            }

            if (!branchStatus.hasChanges) {
                return {
                    success: false,
                    error: 'NO_CHANGES',
                    message: `Branch ${branchName} has no changes compared to main`
                };
            }

            // Check if PR already exists
            let pullRequest = await this.findExistingPR(repository, branchName);
            
            if (!pullRequest) {
                // Create PR first
                this.logger.info('No existing PR found, creating one first...');
                
                const prTitle = this.generatePRTitle(id, title, type);
                const prBody = this.generatePRBody(description, id, type);
                
                try {
                    pullRequest = await this.github.createPullRequest(
                        repository, 
                        branchName, 
                        'main', 
                        prTitle, 
                        prBody
                    );
                    
                    this.logger.info('Successfully created PR before merging', {
                        prNumber: pullRequest.githubId,
                        prUrl: pullRequest.githubUrl
                    });
                    
                    // Update Notion with PR info temporarily
                    await this.updateNotionWithPRInfo(pageId, id, pullRequest.githubUrl, 'Open');
                    
                } catch (error) {
                    return {
                        success: false,
                        error: 'PR_CREATION_FAILED',
                        message: `Failed to create PR before merging: ${error.message}`
                    };
                }
            }

            // Check if PR is mergeable
            const mergeableStatus = await this.checkPRMergeability(repository, pullRequest.githubId);
            if (!mergeableStatus.mergeable) {
                return {
                    success: false,
                    error: 'PR_NOT_MERGEABLE',
                    message: `Pull request #${pullRequest.githubId} is not mergeable: ${mergeableStatus.reason}`
                };
            }

            // Merge the pull request
            this.logger.info(`Merging pull request #${pullRequest.githubId}...`);
            
            const mergeResult = await this.github.mergePullRequest(
                repository, 
                pullRequest.githubId,
                `Merge ${title || pullRequest.title}`,
                'squash' // or 'merge' or 'rebase' based on your preference
            );

            this.logger.info('Successfully merged pull request', {
                prNumber: pullRequest.githubId,
                mergeSha: mergeResult.sha,
                merged: mergeResult.merged
            });

            // Update Notion with merged status
            await this.updateNotionWithPRInfo(pageId, id, pullRequest.githubUrl, 'Merged');

            return {
                success: true,
                message: `Successfully merged pull request #${pullRequest.githubId}`,
                pullRequestUrl: pullRequest.githubUrl,
                pullRequestNumber: pullRequest.githubId,
                branchName,
                repository,
                mergeSha: mergeResult.sha,
                wasCreated: !pullRequest.existed // Track if we created the PR
            };

        } catch (error) {
            this.logger.error('Error merging changes from webhook:', error);
            return {
                success: false,
                error: 'MERGE_FAILED',
                message: `Failed to merge changes: ${error.message}`
            };
        }
    }

    /**
     * Extract page ID from webhook data
     * @param {Object} webhookData - Webhook payload  
     * @returns {string|null} Notion page ID
     */
    extractPageId(webhookData) {
        // Page ID is in data.id
        return webhookData.data?.id || null;
    }

    /**
     * Extract title from webhook data (Notion format)
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Title value
     */
    extractTitle(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different title field names
        const titleProp = properties['Bug Title'] || properties['Task Title'] || properties['Title'] || properties['Name'];
        
        if (titleProp && titleProp.title && Array.isArray(titleProp.title)) {
            // Notion title is an array of text objects
            return titleProp.title.map(t => t.plain_text).join('').trim();
        }
        
        return null;
    }

    /**
     * Extract ID from webhook data (Notion format)
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} ID value (e.g., "CBUG-2")
     */
    extractId(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different ID field names
        const idProp = properties['ID'] || properties['Bug ID'] || properties['Task ID'];
        
        if (idProp && idProp.unique_id) {
            // Notion unique_id format: {prefix: "CBUG", number: 2} -> "CBUG-2"
            return `${idProp.unique_id.prefix}-${idProp.unique_id.number}`;
        }
        
        // Fallback for other ID formats
        if (idProp && idProp.rich_text && Array.isArray(idProp.rich_text)) {
            return idProp.rich_text.map(t => t.plain_text).join('').trim();
        }
        
        return null;
    }

    /**
     * Extract module from webhook data (Notion format)
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Module value
     */
    extractModule(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different module field names  
        const moduleProp = properties['Module'] || properties['Component'] || properties['Area'];
        
        if (moduleProp && moduleProp.select) {
            // Notion select format: {select: {name: "Application"}}
            return moduleProp.select.name;
        }
        
        return 'Application'; // Default fallback
    }

    /**
     * Extract type from webhook data (Notion format)
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Type value
     */
    extractType(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different type field names
        const typeProp = properties['Type'] || properties['Category'];
        
        if (typeProp && typeProp.select) {
            // Notion select format: {select: {name: "Cosmetic"}}
            return typeProp.select.name.toLowerCase();
        }
        
        return 'feature'; // Default fallback
    }

    /**
     * Extract branch URL from webhook data (Notion format)
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Branch URL value
     */
    extractBranchUrl(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different branch URL field names
        const branchProp = properties['Branch Link'] || properties['Branch URL'] || properties['Branch'];
        
        if (branchProp && branchProp.url) {
            return branchProp.url;
        }
        
        return null;
    }

    /**
     * Generate branch name from bug/task data
     * @param {string} id - Bug/Task ID (CBUG-1 or TSK-1)
     * @param {string} title - Issue title
     * @param {string} type - Issue type
     * @returns {string} Branch name
     */
    generateBranchName(id, title, type) {
        // Clean the title for branch name (remove special characters, limit length)
        const cleanTitle = title
            .trim()
            .replace(/[^a-zA-Z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
            .replace(/\s+/g, ' ')            // Normalize spaces
            .substring(0, 50);               // Limit length

        // Format: ID/type-title → CBUG-2/cosmetic-test-bug-fix
        return `${id}/${type.toLowerCase()}-${cleanTitle.toLowerCase().replace(/\s+/g, '-')}`;
    }

    /**
     * Extract description from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Description value
     */
    extractDescription(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        // Try different description field names
        const descProp = properties['Description'] || properties['Details'] || properties['Notes'];
        
        if (descProp && descProp.rich_text && descProp.rich_text.length > 0) {
            return descProp.rich_text.map(text => text.plain_text).join('');
        }
        
        return null;
    }

    /**
     * Extract priority from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Priority value
     */
    extractPriority(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        const priorityProp = properties['Priority'];
        
        if (priorityProp && priorityProp.select) {
            return priorityProp.select.name;
        }
        
        return null;
    }

    /**
     * Extract assignee from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Assignee value
     */
    extractAssignee(webhookData) {
        const properties = webhookData.data?.properties;
        if (!properties) return null;

        const assigneeProp = properties['Assignee'] || properties['Assigned To'];
        
        if (assigneeProp && assigneeProp.people && assigneeProp.people.length > 0) {
            return assigneeProp.people[0].name;
        }
        
        return null;
    }

    /**
     * Get repository from module name
     * @param {string} module - Module name (Application/Firmware)
     * @returns {string|null} Repository path or null
     */
    getRepositoryFromModule(module) {
        try {
            return this.config.getRepositoryForModule(module);
        } catch (error) {
            this.logger.error('Error getting repository for module:', error);
            return null;
        }
    }

    /**
     * Update Notion with branch link
     * @param {string} pageId - Notion page ID
     * @param {string} branchUrl - GitHub branch URL
     * @param {string} id - Bug/Task ID for logging
     */
    async updateNotionWithBranchLink(pageId, branchUrl, id) {
        try {
            this.logger.info('Updating Notion with branch link', { pageId, branchUrl, id });

            // Determine if this is a Bug or Task based on ID format
            const isTask = id.startsWith('TSK-');
            const isBug = id.startsWith('CBUG-') || id.startsWith('BUG-');

            if (isBug) {
                // Use existing NotionClient method for bugs
                await this.notion.updateBugProperties(pageId, {
                    branchUrl: branchUrl
                });
            } else if (isTask) {
                // For tasks, we need to update the Task database directly
                await this.updateTaskBranchLink(pageId, branchUrl);
            } else {
                // Generic update for other types
                await this.updatePageBranchLink(pageId, branchUrl);
            }

            this.logger.info('Successfully updated Notion with branch link', { pageId, id, branchUrl });

        } catch (error) {
            this.logger.error('Error updating Notion with branch link:', error);
            throw error;
        }
    }

    /**
     * Update Task database with branch link
     * @param {string} pageId - Notion page ID
     * @param {string} branchUrl - GitHub branch URL
     */
    async updateTaskBranchLink(pageId, branchUrl) {
        try {
            const response = await this.notion.notion.pages.update({
                page_id: pageId,
                properties: {
                    'Branch Link': {
                        url: branchUrl
                    }
                }
            });
            return response;
        } catch (error) {
            this.logger.error('Error updating task branch link:', error);
            throw error;
        }
    }

    /**
     * Update Task database with PR properties
     * @param {string} pageId - Notion page ID
     * @param {Object} updates - Object containing PR status and/or link
     */
    async updateTaskPRProperties(pageId, updates) {
        try {
            const properties = {};
            
            if (updates.branchUrl) {
                properties['Branch Link'] = {
                    url: updates.branchUrl
                };
            }

            if (updates.pullRequestStatus) {
                properties['Pull Request Status'] = {
                    status: {
                        name: updates.pullRequestStatus
                    }
                };
            }

            if (updates.pullRequestLink) {
                properties['Pull Request Link'] = {
                    url: updates.pullRequestLink
                };
            }

            const response = await this.notion.notion.pages.update({
                page_id: pageId,
                properties
            });
            return response;
        } catch (error) {
            this.logger.error('Error updating task PR properties:', error);
            throw error;
        }
    }

    /**
     * Generic method to update any page with branch/PR properties
     * @param {string} pageId - Notion page ID
     * @param {Object} updates - Object containing properties to update
     */
    async updatePageBranchLink(pageId, updates) {
        try {
            const properties = {};
            
            if (updates.branchUrl) {
                properties['Branch Link'] = {
                    url: updates.branchUrl
                };
            }

            if (updates.pullRequestStatus) {
                properties['Pull Request Status'] = {
                    status: {
                        name: updates.pullRequestStatus
                    }
                };
            }

            if (updates.pullRequestLink) {
                properties['Pull Request Link'] = {
                    url: updates.pullRequestLink
                };
            }

            const response = await this.notion.notion.pages.update({
                page_id: pageId,
                properties
            });
            return response;
        } catch (error) {
            this.logger.error('Error updating page properties:', error);
            throw error;
        }
    }

    /**
     * Update GitHub issue with branch link information
     * @param {string} bugId - Bug ID (e.g., "CBUG-2")
     * @param {string} repository - Repository name (e.g., "owner/repo")
     * @param {string} branchUrl - GitHub branch URL
     * @param {string} branchName - Branch name
     * @returns {Promise<Object>} Update result
     */
    async updateGitHubIssueWithBranchLink(bugId, repository, branchUrl, branchName) {
        try {
            this.logger.info('Searching for GitHub issue with bug ID:', { bugId, repository });

            // Find the GitHub issue corresponding to this bug
            const issue = await this.findGitHubIssueByBugId(bugId, repository);
            
            if (!issue) {
                this.logger.info(`No GitHub issue found for bug ${bugId} in ${repository} - issue may not be created yet`);
                const error = new Error('ISSUE_NOT_FOUND');
                error.message = 'ISSUE_NOT_FOUND';
                throw error;
            }

            this.logger.info(`Found GitHub issue #${issue.number} for bug ${bugId}`);

            // Update the issue body to include branch information in the Development section
            await this.updateGitHubIssueBody(repository, issue.number, issue.body, branchUrl, branchName);

            this.logger.info(`Successfully updated GitHub issue #${issue.number} Development section with branch information`);
            
            return {
                success: true,
                issueNumber: issue.number,
                branchUrl,
                branchName
            };

        } catch (error) {
            if (error.message === 'ISSUE_NOT_FOUND') {
                throw error; // Re-throw as-is for caller to handle
            }
            this.logger.error('Error updating GitHub issue with branch link:', error);
            throw new Error(`Failed to update GitHub issue: ${error.message}`);
        }
    }

    /**
     * Find a GitHub issue by bug ID
     * @param {string} bugId - Bug ID (e.g., "CBUG-2")
     * @param {string} repository - Repository name (e.g., "owner/repo")
     * @returns {Promise<Object|null>} GitHub issue object or null if not found
     */
    async findGitHubIssueByBugId(bugId, repository) {
        try {
            // Fetch all synced issues from the repository
            const issues = await this.github.fetchSyncedIssues(repository);
            
            // Find the issue that matches the bug ID in the title
            const matchingIssue = issues.find(issue => {
                // Use DataMapper to extract bug ID from title
                const extractedId = this.extractBugIdFromIssueTitle(issue.title);
                return extractedId === bugId;
            });

            return matchingIssue || null;

        } catch (error) {
            this.logger.error(`Error finding GitHub issue for bug ${bugId}:`, error);
            throw error;
        }
    }

    /**
     * Extract bug ID from GitHub issue title
     * @param {string} title - GitHub issue title
     * @returns {string|null} Extracted bug ID or null
     */
    extractBugIdFromIssueTitle(title) {
        // Match formats: 
        // New format: "[Bug]/CBUG-2 Test Title" or "[Cosmetic]/CBUG-2 Test Title"
        // Alternative: "CBUG-2: Test Title"
        
        const newFormatMatch = title.match(/^\[.*?\]\/(CBUG-\d+|TSK-\d+)\s+(.+)$/);
        if (newFormatMatch) {
            return newFormatMatch[1]; // Return CBUG-2 or TSK-1
        }

        const alternativeMatch = title.match(/^(CBUG-\d+|TSK-\d+):\s+(.+)$/);
        if (alternativeMatch) {
            return alternativeMatch[1]; // Return CBUG-2 or TSK-1
        }
        
        return null;
    }

    /**
     * Update GitHub issue body to include branch information
     * @param {string} repository - Repository name
     * @param {number} issueNumber - GitHub issue number
     * @param {string} currentBody - Current issue body
     * @param {string} branchUrl - GitHub branch URL
     * @param {string} branchName - Branch name
     */
    async updateGitHubIssueBody(repository, issueNumber, currentBody, branchUrl, branchName) {
        try {
            let newBody = currentBody || '';
            
            // Check if Development section already exists
            if (newBody.includes('## Development')) {
                // Check if this branch is already in the Development section
                if (newBody.includes(branchUrl)) {
                    this.logger.info(`Branch ${branchName} already exists in issue #${issueNumber} Development section`);
                    return;
                }
                
                // Update existing Development section
                const developmentRegex = /(## Development\n)(.*?)(\n\n|$)/s;
                const developmentMatch = newBody.match(developmentRegex);
                
                if (developmentMatch) {
                    const existingContent = developmentMatch[2].trim();
                    const newContent = existingContent 
                        ? `${existingContent}\n**Branch:** [${branchName}](${branchUrl})`
                        : `**Branch:** [${branchName}](${branchUrl})`;
                    
                    newBody = newBody.replace(
                        developmentRegex,
                        `## Development\n${newContent}\n\n`
                    );
                }
            } else {
                // Add new Development section
                const developmentSection = `## Development\n**Branch:** [${branchName}](${branchUrl})`;
                
                if (newBody.includes('---\n*This issue was automatically created from Notion')) {
                    // Insert before the footer
                    newBody = newBody.replace(
                        /---\n\*This issue was automatically created from Notion/,
                        `${developmentSection}\n\n---\n*This issue was automatically created from Notion`
                    );
                } else {
                    // Just append
                    newBody += `\n\n${developmentSection}`;
                }
            }

            await this.github.updateIssueBody(repository, issueNumber, newBody);

            this.logger.info(`Updated issue #${issueNumber} Development section with branch: ${branchName}`);

        } catch (error) {
            this.logger.error(`Error updating issue body for #${issueNumber}:`, error);
            // Don't throw here as this is not critical - the main branch creation succeeded
        }
    }

    /**
     * Parse branch URL to extract repository and branch name
     * @param {string} branchUrl - GitHub branch URL
     * @returns {Object|null} Object with repository and branchName or null
     */
    parseBranchUrl(branchUrl) {
        try {
            // Expected format: https://github.com/owner/repo/tree/branch-name
            const urlPattern = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/(.+)$/;
            const match = branchUrl.match(urlPattern);
            
            if (match) {
                const [, owner, repo, branchName] = match;
                return {
                    repository: `${owner}/${repo}`,
                    branchName: branchName
                };
            }
            
            this.logger.warn(`Could not parse branch URL: ${branchUrl}`);
            return null;
        } catch (error) {
            this.logger.error('Error parsing branch URL:', error);
            return null;
        }
    }

    /**
     * Check if branch exists and has changes compared to main
     * @param {string} repository - Repository name (owner/repo)
     * @param {string} branchName - Branch name
     * @returns {Object} Status object with exists and hasChanges properties
     */
    async checkBranchStatus(repository, branchName) {
        try {
            const [owner, repo] = repository.split('/');
            
            // Check if branch exists
            const branchExists = await this.github.checkBranchExists(repository, branchName);
            if (!branchExists) {
                return { exists: false, hasChanges: false };
            }

            // Check if branch has changes compared to main
            const hasChanges = await this.github.branchHasChanges(repository, branchName, 'main');
            
            return { exists: true, hasChanges };
        } catch (error) {
            this.logger.error('Error checking branch status:', error);
            return { exists: false, hasChanges: false };
        }
    }

    /**
     * Find existing pull request for a branch
     * @param {string} repository - Repository name
     * @param {string} branchName - Branch name
     * @returns {Object|null} Existing PR object or null
     */
    async findExistingPR(repository, branchName) {
        try {
            const prs = await this.github.fetchPullRequests(repository, branchName);
            return prs.length > 0 ? prs[0] : null;
        } catch (error) {
            this.logger.error('Error finding existing PR:', error);
            return null;
        }
    }

    /**
     * Generate pull request title
     * @param {string} id - Bug/Task ID
     * @param {string} title - Issue title
     * @param {string} type - Issue type
     * @returns {string} Formatted PR title
     */
    generatePRTitle(id, title, type) {
        // Format: [Type] ID: Title → [Feature] TSK-8: Complete navigation view
        const typeFormatted = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Feature';
        return `[${typeFormatted}] ${id}: ${title}`;
    }

    /**
     * Generate pull request body
     * @param {string} description - Description from Notion
     * @param {string} id - Bug/Task ID
     * @param {string} type - Issue type
     * @returns {string} Formatted PR body
     */
    generatePRBody(description, id, type) {
        let body = '';
        
        if (description) {
            body += `## Description\n${description}\n\n`;
        }
        
        body += `## Type\n${type || 'Feature'}\n\n`;
        body += `## Changes\n- [ ] Implementation complete\n- [ ] Testing complete\n- [ ] Documentation updated\n\n`;
        body += `---\n*This pull request was automatically created from Notion ${id.startsWith('TSK-') ? 'task' : 'bug'} ${id}*`;
        
        return body;
    }

    /**
     * Update Notion with pull request information
     * @param {string} pageId - Notion page ID
     * @param {string} id - Bug/Task ID
     * @param {string} prUrl - Pull request URL
     * @param {string} prStatus - Pull request status
     */
    async updateNotionWithPRInfo(pageId, id, prUrl, prStatus) {
        try {
            this.logger.info('Updating Notion with PR info', { pageId, id, prUrl, prStatus });

            // Determine if this is a Bug or Task based on ID format
            const isTask = id.startsWith('TSK-');
            const isBug = id.startsWith('CBUG-') || id.startsWith('BUG-');

            const updates = {
                pullRequestStatus: prStatus,
                pullRequestLink: prUrl
            };

            if (isBug) {
                // Use existing NotionClient method for bugs
                await this.notion.updateBugProperties(pageId, updates);
            } else if (isTask) {
                // For tasks, use the task-specific method
                await this.notion.updateTaskProperties(pageId, updates, 'task');
            } else {
                // Generic update for other types
                await this.updatePageBranchLink(pageId, updates);
            }

            this.logger.info('Successfully updated Notion with PR info', { pageId, id, prUrl, prStatus });

        } catch (error) {
            this.logger.error('Error updating Notion with PR info:', error);
            throw error;
        }
    }

    /**
     * Check if a pull request is mergeable
     * @param {string} repository - Repository name
     * @param {number} prNumber - Pull request number
     * @returns {Object} Mergeability status with mergeable boolean and reason
     */
    async checkPRMergeability(repository, prNumber) {
        try {
            // Get detailed PR info from GitHub
            const prDetails = await this.github.getPullRequestDetails(repository, prNumber);
            
            this.logger.info(`PR #${prNumber} mergeable status`, {
                mergeable: prDetails.mergeable,
                mergeableState: prDetails.mergeable_state,
                state: prDetails.state
            });

            if (prDetails.state === 'closed') {
                return {
                    mergeable: false,
                    reason: 'Pull request is already closed'
                };
            }

            if (prDetails.mergeable === false) {
                return {
                    mergeable: false,
                    reason: `Merge conflicts or other issues (state: ${prDetails.mergeable_state})`
                };
            }

            if (prDetails.mergeable === null) {
                // GitHub is still computing mergeability, wait a moment
                this.logger.info('GitHub is still computing mergeability, waiting...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Re-check
                const recheckDetails = await this.github.getPullRequestDetails(repository, prNumber);
                if (recheckDetails.mergeable === false) {
                    return {
                        mergeable: false,
                        reason: `Merge conflicts detected (state: ${recheckDetails.mergeable_state})`
                    };
                }
            }

            return {
                mergeable: true,
                reason: 'Ready to merge'
            };

        } catch (error) {
            this.logger.error('Error checking PR mergeability:', error);
            return {
                mergeable: false,
                reason: `Error checking mergeability: ${error.message}`
            };
        }
    }

    /**
     * Start the webhook server
     * @param {number} port - Port to listen on
     * @returns {Promise} Resolves when server is ready
     */
    start(port = 3000) {
        return new Promise((resolve) => {
            this.server = this.app.listen(port, () => {
                this.logger.info(`Webhook server listening on port ${port}`);
                this.logger.info(`Health check: http://localhost:${port}/health`);
                this.logger.info(`Webhook URL: http://localhost:${port}/webhook/notion`);
                this.logger.info(`Test endpoint: http://localhost:${port}/webhook/test`);
                resolve();
            });
        });
    }

    /**
     * Stop the webhook server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.logger.info('Webhook server stopped');
        }
    }
}

module.exports = WebhookHandler;
