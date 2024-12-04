const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const clc = require('cli-color');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const EventEmitter = require('events');


dotenv.config();
// Configuration
const CONCURRENT_BROWSERS = 1;
const BATCH_SIZE = 1;
const GEMINI_MODEL = 'gemini-1.5-flash';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOW_PROXY = false;
const osPlatform = os.platform();
const executablePath = osPlatform.startsWith('win') ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

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

        console.log(`[Stats] Success Rate: ${clc.green(stats.successRate)}% | Avg Time/Token: ${clc.cyan(stats.avgTimePerToken)}s | Total Attempts: ${clc.yellow(stats.totalAttempts)} | Successful Tokens: ${clc.green(stats.successfulTokens)}`);
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
            console.error('No page set. Call setPage(page) first');
            return;
        }

        if (this.isWatching) {
            console.log('Watcher is already running');
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
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    const browser = await puppeteerExtra.launch({
        headless: false,
        executablePath: executablePath,
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
            ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Update page configuration without request interception
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                delete navigator.__proto__.webdriver;
            });

            await page.setUserAgent(USER_AGENT);

            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);
        }
    });

    return browser;
}

async function launchBrowsers() {
    return Promise.all(
        Array.from({ length: CONCURRENT_BROWSERS }, async (_, index) => {
            await new Promise(resolve => setTimeout(resolve, index * 1000));
            return launchBrowser(`./chrome-user-data/chrome-user-data-${index + 1}`);
        })
    );
}

async function closeBrowser(browser) {
    try {
        await browser.close();
    } catch (error) {
        console.error('Error closing browser:', error);
    }
}

// Add function to analyze image with Gemini
async function analyzeWithGemini(screenshotPath, prompt, gridType) {
    try {
        console.log(`Original prompt: ${prompt}`);

        // Extract main challenge text
        const mainPrompt = prompt.split('Click verify once there are none left')[0].trim()
            .replace(/\.$/, '');

        console.log(`Processed prompt: ${mainPrompt}`);

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                topK: 40,

            }
        });

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
        console.log("\n=== Gemini Response ===");
        console.log(response);
        console.log("=" * 30);

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

        console.log("\n=== Tiles to Click ===");
        console.log(`Found ${tilesToClick.length} tiles to click: ${tilesToClick}`);
        console.log("=" * 30);

        return tilesToClick;

    } catch (error) {
        console.error("\n=== Gemini Analysis Error ===");
        console.error(`Error: ${error.message}`);
        console.error(`Type: ${error.constructor.name}`);
        console.error(`Stack: ${error.stack}`);
        console.error("=" * 30);
        return null;
    }
}

// Add helper function for screenshot and analysis
async function takeScreenshotAndAnalyze(frame, challengeInfo, watcher, iterationInfo = '') {
    const timestamp = Date.now();
    const screenshotPath = `captcha_screenshots/challenge_${timestamp}.png`;
    await fs.mkdir('captcha_screenshots', { recursive: true });

    const challengeArea = await frame.$('.rc-imageselect-challenge');
    if (!challengeArea) {
        console.log('Could not find challenge area element');
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
                console.log('WATCHER: tiles ready - taking screenshot');
                hasResolved = true;
                clearTimeout(timeout);
                resolve();
            }
        });
    }).catch(error => {
        console.log('Error waiting for tiles:', error.message);
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

    console.log(`\nTaking screenshot: ${screenshotPath}`);

    if (iterationInfo) {
        console.log(`\n=== Processing Screenshot ${iterationInfo} ===`);
    }

    // Analyze with Gemini
    return await analyzeWithGemini(
        screenshotPath,
        challengeInfo.promptText || challengeInfo.text,
        challengeInfo.gridType
    );
}

// Update the main challenge solving function
async function solveCaptchaChallenge(page) {
    const watcher = new CaptchaWatcher();
    watcher.setPage(page);

    try {
        // Handle alerts
        page.on('dialog', async dialog => {
            console.log('Alert detected:', dialog.message());
            await dialog.accept();
        });

        // Wait for initial captcha to be ready
        await waitForCaptchaReady(watcher);

        // Click checkbox and handle initial response
        const initialResult = await handleCheckboxClick(watcher);
        if (initialResult) return initialResult; // Return if we got a token immediately

        // Main challenge solving loop
        return await solveChallengeLoop(watcher);

    } catch (error) {
        console.error('Error in solveCaptcha:', error);
        return null;
    } finally {
        watcher.cleanup();
    }
}

// Helper functions to break down the logic
async function waitForCaptchaReady(watcher) {
    await new Promise((resolve) => {
        watcher.onCaptchaReady((captchaInfo) => {
            console.log('\n=== Captcha Ready ===');
            console.log('Time:', captchaInfo.timestamp);
            console.log('Status:', captchaInfo.status);
            resolve();
        });
    });
}

async function handleCheckboxClick(watcher) {
    const checkbox = watcher.getCheckbox();
    if (!checkbox) {
        console.log('Could not get checkbox element');
        return null;
    }

    try {
        await checkbox.click();
        console.log('Clicked recaptcha checkbox');

        // Wait for either immediate token or challenge
        const result = await Promise.race([
            waitForToken(watcher),
            waitForChallenge(watcher)
        ]);

        if (result?.type === 'token') {
            console.log('Captcha solved immediately!');
            return result.value;
        }

        return null;
    } catch (error) {
        console.error('Failed to click checkbox:', error);
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
            console.log('\n=== Challenge Detected ===');
            console.log('Time:', info.timestamp);
            console.log('Challenge prompt:', info.text);
            console.log('Is Dynamic:', info.isDynamic);
            console.log('Has Correct Format:', info.hasCorrectFormat);
            resolve({ type: 'challenge', value: info });
        });
    });
}

async function solveChallengeLoop(watcher) {
    const maxAttempts = 4;
    let attempts = 0;

    while (attempts < maxAttempts) {
        // Get current challenge info and validate
        const challengeInfo = await getCurrentChallenge(watcher);
        if (!challengeInfo) {
            console.log('Failed to get valid challenge');
            attempts++;
            continue;
        }

        // Analyze and click tiles
        const success = await handleChallengeTiles(watcher, challengeInfo);
        if (!success) {
            attempts++;
            continue;
        }

        // Verify solution
        const token = await verifyChallenge(watcher);
        if (token) return token;

        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`Challenge failed after ${maxAttempts} attempts`);
    return null;
}

async function getCurrentChallenge(watcher) {
    const frame = watcher.getChallengeFrame();
    if (!frame) return null;

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
        console.log('Invalid challenge format, refreshing...');
        await refreshChallenge(frame);
        return null;
    }

    return challengeInfo;
}

async function handleChallengeTiles(watcher, challengeInfo) {
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
                        console.log('Tiles ready for analysis');
                        hasResolved = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
        } catch (error) {
            console.log('Error waiting for tiles:', error.message);
            return false;
        }

        // Small delay to ensure stability
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Take screenshot and analyze
        const tilesToClick = await takeScreenshotAndAnalyze(
            watcher.getChallengeFrame(),
            challengeInfo,
            watcher,
            challengeInfo.isDynamic ? `${dynamicIteration + 1}/${maxDynamicIterations}` : ''
        );

        if (!tilesToClick) {
            console.log('Failed to get Gemini analysis');
            return false;
        }

        if (tilesToClick.length === 0) {
            console.log('No matching tiles found - proceeding to verify');
            return true;
        }

        // Click identified tiles
        console.log('\n=== Clicking Tiles ===');
        for (const coord of tilesToClick) {
            const clicked = await clickTile(watcher.getChallengeFrame(), coord, challengeInfo);
            if (!clicked) {
                console.log(`Failed to click tile ${coord}`);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
        }
        console.log('=== Finished Clicking Tiles ===\n');

        // For non-dynamic challenges, we're done after one round
        if (!challengeInfo.isDynamic) break;

        // For dynamic challenges, continue until max iterations
        dynamicIteration++;
        if (dynamicIteration >= maxDynamicIterations) {
            console.log(`Reached maximum dynamic iterations (${maxDynamicIterations})`);
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
        console.error(`Error clicking tile ${coord}:`, error);
        return false;
    }
}

async function verifyChallenge(watcher) {
    const frame = watcher.getChallengeFrame();
    if (!frame) return null;

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
                    console.log('Tiles ready for verification');
                    hasResolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    } catch (error) {
        console.log('Error waiting for tiles before verify:', error.message);
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
        console.log('Verify button not ready or challenge invalid');
        return null;
    }

    const verifyButton = await frame.$('#recaptcha-verify-button');
    if (!verifyButton) return null;

    // Small delay before clicking verify
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

    await verifyButton.click();
    console.log('Clicked verify button');

    // Rest of the verification logic...
    const result = await Promise.race([
        waitForToken(watcher),
        waitForNewChallenge(watcher),
        new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 5000))
    ]);

    if (result?.type === 'token') return result.value;
    if (result?.type === 'challenge') {
        // Handle new challenge
        const newChallengeInfo = result.value;
        if (!newChallengeInfo.hasCorrectFormat) {
            console.log('Invalid new challenge format, refreshing...');
            await refreshChallenge(frame);
            return null;
        }

        // Add delay before processing new challenge
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

        // Handle the new challenge tiles
        const success = await handleChallengeTiles(watcher, newChallengeInfo);
        if (!success) return null;

        // Verify again
        return await verifyChallenge(watcher);
    }
    return null;
}

async function waitForNewChallenge(watcher) {
    return new Promise((resolve) => {
        watcher.onChallengeChange((info) => {
            console.log('\n=== Challenge Changed ===');
            console.log('Time:', info.timestamp);
            console.log('New Challenge prompt:', info.text);
            console.log('Is Dynamic:', info.isDynamic);
            console.log('Has Correct Format:', info.hasCorrectFormat);
            resolve({ type: 'challenge', value: info });
        });
    });
}

async function refreshChallenge(frame) {
    const reloadButton = await frame.$('#recaptcha-reload-button');
    if (reloadButton) {
        await reloadButton.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Update the main generateTokens function to use audio solving
async function generateTokens(count, eventEmitter) {
    const resultTracker = new ResultTracker();
    const browsers = await launchBrowsers();
    const tabsPerBrowser = Math.ceil(count / browsers.length);

    try {
        const allPromises = [];
        let tokensGenerated = 0;

        for (let browserIndex = 0; browserIndex < browsers.length; browserIndex++) {
            const browser = browsers[browserIndex];
            const tabPromises = [];

            const remainingTokens = count - tokensGenerated;
            const tabsForThisBrowser = Math.min(tabsPerBrowser, remainingTokens);

            for (let tabIndex = 0; tabIndex < tabsForThisBrowser; tabIndex++) {
                const tabPromise = (async () => {
                    const page = await browser.newPage();

                    try {
                        await page.setUserAgent(USER_AGENT);

                        await page.goto('https://www.google.com/recaptcha/api2/demo', {
                            waitUntil: 'domcontentloaded',
                            timeout: 120000
                        });

                        const token = await solveCaptchaChallenge(page);
                        if (token) {
                            eventEmitter.emit('tokenGenerated', { token });
                            tokensGenerated++;
                            resultTracker.addResult({ success: true, status: 'ACTIVE' });
                        } else {
                            resultTracker.addResult({ success: false, status: 'ERROR' });
                        }

                        resultTracker.printStats();

                    } catch (error) {
                        console.error('Error generating token:', error);
                        eventEmitter.emit('tokenError', { error: error.message });
                        resultTracker.addResult({ success: false, status: 'ERROR' });
                        resultTracker.printStats();
                    } finally {
                        await page.close().catch(console.error);
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

// Update the main execution block
if (require.main === module) {
    const resultTracker = new ResultTracker();
    const eventEmitter = new EventEmitter();

    // Set up event listeners
    eventEmitter.on('tokenGenerated', (data) => {
        console.log(clc.green('\nToken generated:'));
        console.log(clc.yellow(data.token.slice(0, 50) + '...\n'));
        resultTracker.addResult({ success: true, status: 'ACTIVE' });
    });

    eventEmitter.on('tokenError', (data) => {
        console.log(clc.red('\nError:', data.error, '\n'));
        resultTracker.addResult({ success: false, status: 'INACTIVE' });
    });

    console.log(clc.cyan('Starting token generation...'));

    // Infinite loop function
    const runInfinitely = async () => {
        while (true) {
            try {
                await generateTokens(BATCH_SIZE, eventEmitter);
                console.log(clc.green('Batch complete, starting next batch...'));
                resultTracker.printStats();
            } catch (error) {
                console.error(clc.red('Error in batch:'), error);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };

    runInfinitely().catch(console.error);
} else {
    module.exports = generateTokens;
}
