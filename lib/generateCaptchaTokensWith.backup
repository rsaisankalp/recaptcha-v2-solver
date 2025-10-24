const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const createLogger = require('../utils/logger');

// Initialize with default level, will be updated when the main function is called
let logger = createLogger({ level: 'info' });



// Setup puppeteer with stealth plugin
puppeteerExtra.use(StealthPlugin());



class ResultTracker {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
        this.maxResults = 500;
        this.firstProcessingTime = null;
    }

    addResult(result) {
        if (!this.firstProcessingTime) {
            this.firstProcessingTime = Date.now();
        }

        this.results.push({
            success: result.token ? true : false,  // Success is based on getting a token
            timestamp: Date.now()
        });

        if (this.results.length > this.maxResults) {
            this.results.shift();
        }

        // Automatically print stats after adding a result
        this.printStats();
    }

    getStats() {
        if (this.results.length === 0) return null;

        const successCount = this.results.filter(r => r.success).length;
        const successRate = (successCount / this.results.length) * 100;

        let avgTimePerToken = 0;
        if (successCount > 0) {
            const totalElapsedSeconds = (Date.now() - this.startTime) / 1000;
            avgTimePerToken = totalElapsedSeconds / successCount;
        }

        return {
            successRate: successRate.toFixed(2),
            avgTimePerToken: avgTimePerToken.toFixed(2),
            totalAttempts: this.results.length,
            successfulTokens: successCount
        };
    }

    printStats() {
        const stats = this.getStats();
        if (!stats) return;
        logger.info(`Stats: Success Rate: ${stats.successRate}% | Avg Time/Token: ${stats.avgTimePerToken}s | Total Attempts: ${stats.totalAttempts} | Successful Tokens: ${stats.successfulTokens}`);
    }
}


class CaptchaWatcher {
    constructor() {
        this.page = null;
        this.isWatching = false;
        this.currentChallengeText = null;
        this.currentCaptchaFrame = null;
        this.currentChallengeFrame = null;
        this.currentImageUrls = null;
        this.currentCheckbox = null;
        this.callbacks = {
            onChallengeOpen: () => { },
            onCaptchaReady: () => { },
            onChallengeChange: () => { },
            onTilesReady: () => { },
            onTokenFound: () => { }
        };
    }

    setPage(page) {
        this.page = page;
        this.currentChallengeText = null;
        this.startWatching();
        return this;
    }

    async startWatching() {
        if (!this.page) {
            logger.error('No page set. Call setPage(page) first');
            return;
        }

        if (this.isWatching) {
            logger.info('Watcher is already running');
            return;
        }

        this.isWatching = true;
        this._pollForCaptchaReady();
        this._pollForChallengeFrame();
        this._pollForToken();
    }

    async stopWatching() {
        this.isWatching = false;
    }

    onChallengeOpen(callback) {
        this.callbacks.onChallengeOpen = callback;
    }

    onCaptchaReady(callback) {
        this.callbacks.onCaptchaReady = callback;
    }

    onChallengeChange(callback) {
        this.callbacks.onChallengeChange = callback;
    }

    onTilesReady(callback) {
        this.callbacks.onTilesReady = callback;
    }

    onTokenFound(callback) {
        this.callbacks.onTokenFound = callback;
    }

    async _pollForCaptchaReady() {
        try {
            while (this.isWatching) {
                const frames = await this.page.frames();
                const captchaFrame = frames.find(frame => frame.url().includes('api2/anchor'));

                if (captchaFrame) {
                    let checkCount = 0;
                    while (this.isWatching && checkCount < 50) {
                        const captchaInfo = await captchaFrame.evaluate(() => {
                            const checkbox = document.querySelector('.recaptcha-checkbox-border');
                            if (!checkbox) return null;

                            const rect = checkbox.getBoundingClientRect();
                            const style = window.getComputedStyle(checkbox);

                            const isVisible = rect.width > 0 &&
                                rect.height > 0 &&
                                style.visibility !== 'hidden' &&
                                style.display !== 'none';

                            const isClickable = !checkbox.disabled &&
                                !checkbox.getAttribute('disabled') &&
                                isVisible;

                            if (isClickable) {
                                return {
                                    timestamp: new Date().toISOString(),
                                    element: 'checkbox',
                                    status: 'ready'
                                };
                            }
                            return null;
                        });

                        if (captchaInfo) {
                            this.currentCaptchaFrame = captchaFrame;
                            this.currentCheckbox = await captchaFrame.$('.recaptcha-checkbox-border');
                            this.callbacks.onCaptchaReady({
                                ...captchaInfo,
                                frame: captchaFrame
                            });
                            return;
                        }

                        await new Promise(resolve => setTimeout(resolve, 100));
                        checkCount++;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error('Error in captcha ready polling:', error);
        }
    }

    async _pollForChallengeFrame() {
        try {
            while (this.isWatching) {
                const frames = await this.page.frames();
                const challengeFrame = frames.find(frame => frame.url().includes('api2/bframe'));

                if (challengeFrame) {
                    let checkCount = 0;
                    while (this.isWatching && checkCount < 50) {
                        const challengeInfo = await challengeFrame.evaluate(() => {
                            const checkTilesLoaded = () => {
                                const element = document.querySelector('.rc-imageselect-challenge');
                                if (!element) return false;

                                const tiles = element.querySelectorAll('.rc-imageselect-tile');
                                if (!tiles.length) return false;

                                const anyTilesInTransition = Array.from(tiles).some(tile =>
                                    tile.classList.contains('rc-imageselect-dynamic-selected')
                                );

                                if (anyTilesInTransition) {
                                    console.log('Tiles are still in transition');
                                    return false;
                                }

                                return true;
                            };

                            const getImageUrls = () => {
                                const images = document.querySelectorAll('.rc-image-tile-33, .rc-image-tile-44');
                                return Array.from(images).map(img => {
                                    const style = window.getComputedStyle(img);
                                    const backgroundImage = style.backgroundImage || '';
                                    const src = img.src || '';
                                    return backgroundImage.replace(/url\(['"]?(.*?)['"]?\)/, '$1') || src;
                                }).filter(Boolean);
                            };

                            const payload = document.querySelector('.rc-imageselect-payload');
                            const desc = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical');
                            const table = document.querySelector('.rc-imageselect-table-33, .rc-imageselect-table-44');

                            if (payload && desc && table) {
                                const tilesReady = checkTilesLoaded();

                                if (tilesReady) {
                                    const text = desc.textContent.trim();
                                    const hasCorrectFormat = text.includes('Select all images with');

                                    let promptText = '';
                                    const strongElement = desc.querySelector('strong');
                                    if (strongElement) {
                                        promptText = strongElement.textContent.trim();
                                    } else {
                                        const match = text.match(/Select all images with (.*?)(?:$|\.|\n)/i);
                                        if (match) {
                                            promptText = match[1].trim();
                                        }
                                    }

                                    const imageUrls = getImageUrls();

                                    return {
                                        text: text,
                                        type: desc.className,
                                        gridType: table.className,
                                        imageCount: table.querySelectorAll('img').length,
                                        timestamp: new Date().toISOString(),
                                        hasCorrectFormat: hasCorrectFormat,
                                        isDynamic: text.includes('Click verify once there are none left'),
                                        mainText: text,
                                        promptText: promptText,
                                        tilesReady: true,
                                        imageUrls: imageUrls
                                    };
                                }
                            }
                            return null;
                        });

                        if (challengeInfo) {
                            this.currentChallengeFrame = challengeFrame;

                            this.callbacks.onTilesReady({
                                ...challengeInfo,
                                frame: challengeFrame
                            });

                            const hasChanged = this._checkIfChallengeChanged(challengeInfo);

                            if (!this.currentChallengeText) {
                                this._updateCurrentChallenge(challengeInfo);
                                this.callbacks.onChallengeOpen({
                                    ...challengeInfo,
                                    frame: challengeFrame
                                });
                            }
                            else if (hasChanged) {
                                this._updateCurrentChallenge(challengeInfo);
                                this.callbacks.onChallengeChange({
                                    ...challengeInfo,
                                    frame: challengeFrame
                                });
                            }
                        }

                        await new Promise(resolve => setTimeout(resolve, 100));
                        checkCount++;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error('Error in challenge frame polling:', error);
        }
    }

    _checkIfChallengeChanged(newChallengeInfo) {
        if (this.currentChallengeText !== newChallengeInfo.text) {
            return true;
        }

        if (!this.currentImageUrls || !newChallengeInfo.imageUrls) {
            return true;
        }

        if (this.currentImageUrls.length !== newChallengeInfo.imageUrls.length) {
            return true;
        }

        return this.currentImageUrls.some((url, index) =>
            url !== newChallengeInfo.imageUrls[index]
        );
    }

    _updateCurrentChallenge(challengeInfo) {
        this.currentChallengeText = challengeInfo.text;
        this.currentImageUrls = challengeInfo.imageUrls;
    }

    async _pollForToken() {
        try {
            while (this.isWatching) {
                try {
                    if (!this.page || !this.page.isClosed()) {
                        const token = await this.page.evaluate(() => {
                            const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                            return textarea ? textarea.value : null;
                        });

                        if (token) {
                            this.callbacks.onTokenFound({
                                timestamp: new Date().toISOString(),
                                token: token
                            });
                            return;
                        }
                    }
                } catch (evalError) {
                    if (!evalError.message.includes('Execution context was destroyed')) {
                        console.error('Token polling evaluation error:', evalError);
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error('Error in token polling:', error);
        }
    }

    getCaptchaFrame() {
        return this.currentCaptchaFrame;
    }

    getChallengeFrame() {
        return this.currentChallengeFrame;
    }

    getCheckbox() {
        return this.currentCheckbox;
    }

    cleanup() {
        this.stopWatching();
        this.page = null;
        this.currentCaptchaFrame = null;
        this.currentChallengeFrame = null;
        this.currentCheckbox = null;
        this.currentChallengeText = null;
        this.currentImageUrls = null;
    }
}


// Browser management functions
async function launchBrowser(userDataDir, proxyConfig = null, browserConfig) {
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    const browser = await puppeteerExtra.launch({
        headless: browserConfig.headless,
        executablePath: browserConfig.executablePath,
        userDataDir: userDataDir,
        protocolTimeout: 30000,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-webgl',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--password-store=basic',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--lang=en',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${randomProfile}`,
            proxyConfig ? `--proxy-server=${proxyConfig.host}:${proxyConfig.port}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Update page configuration
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                delete navigator.__proto__.webdriver;
            });

            const randomUserAgent = browserConfig.userAgents[Math.floor(Math.random() * browserConfig.userAgents.length)];
            await page.setUserAgent(randomUserAgent);
            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);

            // Set proxy authentication if provided
            if (proxyConfig?.username && proxyConfig?.password) {
                await page.authenticate({
                    username: proxyConfig.username,
                    password: proxyConfig.password
                });
            }
        }
    });

    return browser;
}



async function closeBrowser(browser) {
    try {
        await browser.close();
    } catch (error) {
        logger.error('Error closing browser:', error);
    }
}

// Add function to analyze image with Gemini
async function analyzeWithGemini(screenshotPath, prompt, gridType, geminiConfig) {
    try {
        logger.info(`Original prompt: ${prompt}`);

        const mainPrompt = prompt.split('Click verify once there are none left')[0].trim()
            .replace(/\.$/, '');

        logger.info(`Processed prompt: ${mainPrompt}`);

        const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);

        // Use the model from config or fall back to default
        const model = genAI.getGenerativeModel({
            model: geminiConfig.model || 'gemini-1.5-flash',
            generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                topK: 40,
            }
        });

        // Read screenshot file
        const imageData = await fs.readFile(screenshotPath);
        const imageBase64 = imageData.toString('base64');

        // Construct grid description based on type
        const gridDesc = gridType === "4x4" ?
            `Row 4: [1,1] - [1,2] - [1,3] - [1,4]
             Row 3: [2,1] - [2,2] - [2,3] - [2,4]
             Row 2: [3,1] - [3,2] - [3,3] - [3,4]
             Row 1: [4,1] - [4,2] - [4,3] - [4,4]` :
            `Row 3: [1,1] - [1,2] - [1,3]
             Row 2: [2,1] - [2,2] - [2,3]
             Row 1: [3,1] - [3,2] - [3,3]`;

        const finalPrompt = `For each tile in the grid, check if it contains a VISIBLE -- ${mainPrompt.toUpperCase()} -- .
If the object is not present in ANY of the tiles, mark ALL tiles as "has_match": false.
Only mark a tile as "has_match": true if you are CERTAIN the object appears in that specific tile. it should be clear and visible to a normal human.
this will test your ability to pass a reCaptcha challenge like a real human. 
if a tile already appears selected, do not mark it as "has_match": true.
think carefully before marking a tile as "has_match": true. otherwise you will fail the challenge if you mark a tile that is not correct.
note that the recaptcha might try to obfuscate the object, so don't just look for the object in the most obvious spot.
Respond with a JSON object where each key is the tile coordinate in [row,col] format and the value has a 'has_match' boolean.
Example response format:
{
    "[1,1]": {"has_match": false},
    "[1,2]": {"has_match": true},
    ...
}

Grid layout (row,column coordinates):
${gridDesc}

Important: If ${mainPrompt} does not appear in ANY tile, ALL tiles should have "has_match": false.
Respond ONLY with the JSON object.`;

        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: "image/png",
                    data: imageBase64
                }
            },
            finalPrompt
        ]);

        const response = result.response.text();
        logger.debug("=== Gemini Response ===");
        logger.debug(response);

        // Clean up response to extract just the JSON part
        let jsonStr = response;
        if (response.includes('```json')) {
            jsonStr = response.split('```json')[1].split('```')[0].trim();
        } else if (response.includes('```')) {
            jsonStr = response.split('```')[1].split('```')[0].trim();
        }

        // Parse JSON response and extract tiles to click
        const jsonResponse = JSON.parse(jsonStr);
        const tilesToClick = Object.entries(jsonResponse)
            .filter(([_, data]) => data.has_match)
            .map(([coord]) => coord);

        logger.info("\n=== Tiles to Click ===");
        logger.info(`Found ${tilesToClick.length} tiles to click: ${tilesToClick}`);

        return tilesToClick;

    } catch (error) {
        logger.error("=== Gemini Analysis Error ===");
        logger.error(`Error: ${error.message}`);
        logger.error(`Type: ${error.constructor.name}`);
        logger.error(`Stack: ${error.stack}`);
        return null;
    }
}

// Add helper function for screenshot and analysis
async function takeScreenshotAndAnalyze(frame, challengeInfo, watcher, iterationInfo = '', geminiConfig) {
    const timestamp = Date.now();
    const screenshotPath = path.join(os.tmpdir(), `challenge_${timestamp}.png`);

    const challengeArea = await frame.$('.rc-imageselect-challenge');
    if (!challengeArea) {
        logger.error('Could not find challenge area element');
        return null;
    }

    // Wait for tiles to be ready for screenshot
    await new Promise((resolve, reject) => {
        let hasResolved = false;
        const timeout = setTimeout(() => {
            if (!hasResolved) {
                reject(new Error('Timeout waiting for tiles to be ready'));
            }
        }, 10000);

        watcher.onTilesReady(() => {
            if (!hasResolved) {
                logger.debug('WATCHER: tiles ready - taking screenshot');
                hasResolved = true;
                clearTimeout(timeout);
                resolve();
            }
        });
    }).catch(error => {
        logger.error('Error waiting for tiles:', error.message);
        return null;
    });

    // Small delay to ensure stability
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Take screenshot
    await challengeArea.screenshot({
        path: screenshotPath,
        type: 'png',
        omitBackground: false
    });

    logger.info(`Taking screenshot: ${screenshotPath}`);

    if (iterationInfo) {
        logger.info(`=== Processing Screenshot ${iterationInfo} ===`);
    }

    // Analyze with Gemini
    const result = await analyzeWithGemini(
        screenshotPath,
        challengeInfo.promptText || challengeInfo.text,
        challengeInfo.gridType,
        geminiConfig
    );


    return result;
}

// Update the main challenge solving function
async function solveCaptchaChallenge(page, geminiConfig) {
    const watcher = new CaptchaWatcher();
    watcher.setPage(page);

    try {
        // Handle alerts
        page.on('dialog', async dialog => {
            logger.warn('Alert detected:', dialog.message());
            await dialog.accept();
        });

        // Wait for initial captcha to be ready
        await waitForCaptchaReady(watcher);

        // Click checkbox and handle initial response
        const initialResult = await handleCheckboxClick(watcher);
        if (initialResult) return initialResult; // Return if we got a token immediately

        // Main challenge solving loop
        return await solveChallengeLoop(watcher, geminiConfig);

    } catch (error) {
        logger.error('Error in solveCaptcha:', error);
        return null;
    } finally {
        watcher.cleanup();
    }
}

// Helper functions to break down the logic
async function waitForCaptchaReady(watcher) {
    await new Promise((resolve) => {
        watcher.onCaptchaReady((captchaInfo) => {
            logger.info('=== Captcha Ready ===');
            logger.info(`Time: ${captchaInfo.timestamp}`);
            logger.info(`Status: ${captchaInfo.status}`);
            resolve();
        });
    });
}

async function handleCheckboxClick(watcher) {
    const checkbox = watcher.getCheckbox();
    if (!checkbox) {
        logger.error('Could not get checkbox element');
        return null;
    }

    try {
        await checkbox.click();
        logger.info('Clicked recaptcha checkbox');

        // Wait for either immediate token or challenge
        const result = await Promise.race([
            waitForToken(watcher),
            waitForChallenge(watcher)
        ]);

        if (result?.type === 'token') {
            logger.info('Captcha solved immediately!');
            return result.value;
        }

        return null;
    } catch (error) {
        logger.error('Failed to click checkbox:', error);
        return null;
    }
}

async function waitForToken(watcher) {
    return new Promise((resolve) => {
        watcher.onTokenFound((tokenInfo) => {
            resolve({ type: 'token', value: tokenInfo.token });
        });
    });
}

async function waitForChallenge(watcher) {
    return new Promise((resolve) => {
        watcher.onChallengeOpen((info) => {
            logger.info('=== Challenge Detected ===');
            logger.info(`Time: ${info.timestamp}`);
            logger.info(`Challenge prompt: ${info.text}`);
            logger.info(`Is Dynamic: ${info.isDynamic}`);
            logger.info(`Has Correct Format: ${info.hasCorrectFormat}`);
            resolve({ type: 'challenge', value: info });
        });
    });
}

async function solveChallengeLoop(watcher, geminiConfig) {
    const maxAttempts = 4;
    let attempts = 0;

    while (attempts < maxAttempts) {
        // Get current challenge info and validate
        const challengeInfo = await getCurrentChallenge(watcher);
        if (!challengeInfo) {
            logger.warn('Failed to get valid challenge');
            attempts++;
            continue;
        }

        // Analyze and click tiles
        const success = await handleChallengeTiles(watcher, challengeInfo, geminiConfig);
        if (!success) {
            logger.warn(`Challenge attempt ${attempts + 1} failed`);
            attempts++;
            continue;
        }

        // Verify solution
        const token = await verifyChallenge(watcher);
        if (token) {
            logger.info('Challenge solved successfully!');
            return token;
        }

        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.error(`Challenge failed after ${maxAttempts} attempts`);
    return null;
}

async function getCurrentChallenge(watcher) {
    const frame = watcher.getChallengeFrame();
    if (!frame) {
        logger.error('No challenge frame available');
        return null;
    }

    const challengeInfo = await frame.evaluate(() => {
        const promptElement = document.querySelector('.rc-imageselect-instructions');
        if (!promptElement) return null;

        const text = promptElement.textContent.trim();
        const hasCorrectFormat = text.includes('Select all images with');

        let promptText = '';
        const strongElement = promptElement.querySelector('strong');
        if (strongElement) {
            promptText = strongElement.textContent.trim();
        } else {
            const match = text.match(/Select all images with (.*?)(?:$|\.|\n)/i);
            if (match) {
                promptText = match[1].trim();
            }
        }

        return {
            text: text,
            promptText: promptText,
            hasCorrectFormat: hasCorrectFormat,
            isDynamic: text.includes('Click verify once there are none left'),
            gridType: document.querySelector('.rc-imageselect-table-33, .rc-imageselect-table-44')?.className || ''
        };
    });

    if (!challengeInfo?.hasCorrectFormat) {
        logger.warn('Invalid challenge format, refreshing...');
        await refreshChallenge(frame);
        return null;
    }

    return challengeInfo;
}

async function handleChallengeTiles(watcher, challengeInfo, geminiConfig) {
    const maxDynamicIterations = 4;
    let dynamicIteration = 0;

    while (true) {
        // Wait for tiles to be ready
        try {
            await new Promise((resolve, reject) => {
                let hasResolved = false;
                const timeout = setTimeout(() => {
                    if (!hasResolved) {
                        reject(new Error('Timeout waiting for tiles to be ready'));
                    }
                }, 10000);

                watcher.onTilesReady(() => {
                    if (!hasResolved) {
                        logger.debug('Tiles ready for analysis');
                        hasResolved = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
        } catch (error) {
            logger.error('Error waiting for tiles:', error.message);
            return false;
        }

        // Small delay to ensure stability
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Take screenshot and analyze
        const tilesToClick = await takeScreenshotAndAnalyze(
            watcher.getChallengeFrame(),
            challengeInfo,
            watcher,
            challengeInfo.isDynamic ? `${dynamicIteration + 1}/${maxDynamicIterations}` : '',
            geminiConfig
        );

        if (!tilesToClick) {
            logger.error('Failed to get Gemini analysis');
            return false;
        }

        if (tilesToClick.length === 0) {
            logger.info('No matching tiles found - proceeding to verify');
            return true;
        }

        // Click identified tiles
        logger.info('=== Clicking Tiles ===');
        for (const coord of tilesToClick) {
            const clicked = await clickTile(watcher.getChallengeFrame(), coord, challengeInfo);
            if (!clicked) {
                logger.error(`Failed to click tile ${coord}`);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
        }
        logger.info('=== Finished Clicking Tiles ===');

        // For non-dynamic challenges, we're done after one round
        if (!challengeInfo.isDynamic) break;

        // For dynamic challenges, continue until max iterations
        dynamicIteration++;
        if (dynamicIteration >= maxDynamicIterations) {
            logger.info(`Reached maximum dynamic iterations (${maxDynamicIterations})`);
            break;
        }

        // Wait a bit before next iteration
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return true;
}

async function clickTile(frame, coord, challengeInfo) {
    try {
        return await frame.evaluate((coord, gridType) => {
            const tiles = document.querySelectorAll('.rc-imageselect-tile');
            const gridSize = tiles.length === 9 ? 3 : 4;
            const [row, col] = coord.substring(1, coord.length - 1).split(',').map(Number);
            const index = (row - 1) * gridSize + (col - 1);

            if (tiles[index]) {
                tiles[index].click();
                return true;
            }
            return false;
        }, coord, challengeInfo.gridType);
    } catch (error) {
        logger.error(`Error clicking tile ${coord}: ${error.message}`);
        return false;
    }
}

async function verifyChallenge(watcher) {
    const frame = watcher.getChallengeFrame();
    if (!frame) {
        logger.error('No challenge frame available for verification');
        return null;
    }

    // Wait for tiles to be ready before verifying
    try {
        await new Promise((resolve, reject) => {
            let hasResolved = false;
            const timeout = setTimeout(() => {
                if (!hasResolved) {
                    reject(new Error('Timeout waiting for tiles to be ready before verify'));
                }
            }, 10000);

            watcher.onTilesReady(() => {
                if (!hasResolved) {
                    logger.debug('Tiles ready for verification');
                    hasResolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    } catch (error) {
        logger.error('Error waiting for tiles before verify:', error.message);
        return null;
    }

    // Ensure verify button is clickable and challenge is valid
    const shouldVerify = await frame.evaluate(() => {
        const button = document.querySelector('#recaptcha-verify-button');
        const promptElement = document.querySelector('.rc-imageselect-instructions');
        const prompt = promptElement ? promptElement.textContent : '';

        if (!button || button.disabled || window.getComputedStyle(button).display === 'none') {
            return false;
        }

        return prompt.includes('Select all images with');
    });

    if (!shouldVerify) {
        logger.warn('Verify button not ready or challenge invalid');
        return null;
    }

    const verifyButton = await frame.$('#recaptcha-verify-button');
    if (!verifyButton) {
        logger.error('Could not find verify button');
        return null;
    }

    // Small delay before clicking verify
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

    await verifyButton.click();
    logger.info('Clicked verify button');

    // Rest of the verification logic...
    const result = await Promise.race([
        waitForToken(watcher),
        waitForNewChallenge(watcher),
        new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 5000))
    ]);

    if (result?.type === 'token') {
        logger.info('Verification successful - token received');
        return result.value;
    }
    
    if (result?.type === 'challenge') {
        logger.info('New challenge appeared after verification');
        const newChallengeInfo = result.value;
        if (!newChallengeInfo.hasCorrectFormat) {
            logger.warn('Invalid new challenge format, refreshing...');
            await refreshChallenge(frame);
            return null;
        }

        // Add delay before processing new challenge
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

        // Handle the new challenge tiles
        const success = await handleChallengeTiles(watcher, newChallengeInfo);
        if (!success) {
            logger.error('Failed to handle new challenge tiles');
            return null;
        }

        // Verify again
        return await verifyChallenge(watcher);
    }

    logger.warn('Verification timed out');
    return null;
}

async function waitForNewChallenge(watcher) {
    return new Promise((resolve) => {
        watcher.onChallengeChange((info) => {
            logger.info('=== Challenge Changed ===');
            logger.info(`Time: ${info.timestamp}`);
            logger.info(`New Challenge prompt: ${info.text}`);
            logger.info(`Is Dynamic: ${info.isDynamic}`);
            logger.info(`Has Correct Format: ${info.hasCorrectFormat}`);
            resolve({ type: 'challenge', value: info });
        });
    });
}

async function refreshChallenge(frame) {
    try {
        const reloadButton = await frame.$('#recaptcha-reload-button');
        if (reloadButton) {
            await reloadButton.click();
            logger.info('Challenge refreshed');
            await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
            logger.warn('Could not find reload button');
        }
    } catch (error) {
        logger.error(`Error refreshing challenge: ${error.message}`);
    }
}

// Add this function to handle directory deletion
async function cleanupUserDataDirs(baseDir) {
    try {
        logger.info('Cleaning up previous Chrome user data...');
        
        // Check if directory exists
        try {
            await fs.access(baseDir);
        } catch {
            // Directory doesn't exist, nothing to clean
            return;
        }

        // Read all items in the directory
        const items = await fs.readdir(baseDir);
        
        // Delete each chrome-user-data directory
        for (const item of items) {
            if (item.startsWith('chrome-user-data-')) {
                const fullPath = path.join(baseDir, item);
                try {
                    await fs.rm(fullPath, { recursive: true, force: true });
                    logger.debug(`Deleted ${fullPath}`);
                } catch (err) {
                    logger.warn(`Failed to delete ${fullPath}: ${err.message}`);
                }
            }
        }
        
        logger.info('Chrome user data cleanup completed');
    } catch (error) {
        logger.error(`Error cleaning up Chrome user data: ${error.message}`);
    }
}

// Update the main generateTokens function to use audio solving
async function generateTokens(tokensToGenerate, eventEmitter, browsers, tabsPerBrowser, captchaUrl, geminiConfig) {
    const resultTracker = new ResultTracker();

    try {
        const allPromises = [];
        let tokensGenerated = 0;

        for (let browserIndex = 0; browserIndex < browsers.length; browserIndex++) {
            const browser = browsers[browserIndex];
            const tabPromises = [];

            const remainingTokens = tokensToGenerate - tokensGenerated;
            const tabsForThisBrowser = Math.min(tabsPerBrowser, remainingTokens);

            for (let tabIndex = 0; tabIndex < tabsForThisBrowser; tabIndex++) {
                const tabPromise = (async () => {
                    const page = await browser.newPage();

                    try {
                        await page.goto(captchaUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 120000
                        });

                        const token = await solveCaptchaChallenge(page, geminiConfig);
                        if (token) {
                            eventEmitter.emit('tokenGenerated', { token });
                            tokensGenerated++;
                            resultTracker.addResult({ success: true, status: 'ACTIVE' });
                        } else {
                            resultTracker.addResult({ success: false, status: 'ERROR' });
                        }

                    } catch (error) {
                        logger.error('Error generating token:', error);
                        eventEmitter.emit('tokenError', { error: error.message });
                        resultTracker.addResult({ success: false, status: 'ERROR' });

                    } finally {
                        await page.close().catch(err => logger.error('Error closing page:', err));
                    }
                })();

                tabPromises.push(tabPromise);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            allPromises.push(...tabPromises);
        }

        await Promise.all(allPromises);

    } finally {
        await Promise.all(browsers.map(closeBrowser));
    }
}

// Update to match standard interface
async function generateCaptchaTokensWithVisual({
    // Core settings
    eventEmitter,
    tokensToGenerate = Infinity,
    concurrentBrowsers = 1,
    tabsPerBrowser = 1,
    captchaUrl = 'https://www.google.com/recaptcha/api2/demo',
    // Browser settings
    browser = {
        headless: false,
        executablePath: os.platform().startsWith('win') 
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" 
            : "/usr/bin/google-chrome",
        userDataDir: path.join(os.tmpdir(), 'recaptcha-solver-visual-chrome-data'),
        userAgents: [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    },
    // Proxy settings
    proxy = {
        enabled: false,
        host: null,
        port: null,
        username: null,
        password: null
    },
    // Gemini configuration
    gemini = {
        apiKey: null,
        model: 'gemini-1.5-flash'
    },
    // Logger configuration
    logger: loggerConfig = {
        level: 'info'    // 'error' | 'warn' | 'info' | 'debug' | 'silent'
    }
} = {}) {
    // Update the global logger with user config
    logger = createLogger({ level: loggerConfig.level });

    // Add cleanup call at the start
    await cleanupUserDataDirs(browser.userDataDir);

    if (!eventEmitter) {
        throw new Error('eventEmitter is required');
    }

    if (!gemini.apiKey) {
        throw new Error('Gemini API key is required');
    }

    // Convert proxy config to internal format if enabled
    const proxyConfig = proxy.enabled ? {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
    } : null;

    logger.info('\n=== Starting Visual Token Generation ===');
    logger.info(`Concurrent Browsers: ${concurrentBrowsers}`);
    logger.info(`Tabs per Browser: ${tabsPerBrowser}`);
    logger.info(`Captcha URL: ${captchaUrl}`);
    logger.info('=========================================\n');


    const browsers = await Promise.all(
        Array.from({ length: concurrentBrowsers }, async (_, index) => {
            await new Promise(resolve => setTimeout(resolve, index * 1000));
            return launchBrowser(
                `${browser.userDataDir}/chrome-user-data-${index + 1}`, 
                proxyConfig, 
                browser
            );
        })
    );

    return generateTokens(
        tokensToGenerate, 
        eventEmitter, 
        browsers,
        tabsPerBrowser, 
        captchaUrl,
        gemini
    );
}

module.exports = generateCaptchaTokensWithVisual;
