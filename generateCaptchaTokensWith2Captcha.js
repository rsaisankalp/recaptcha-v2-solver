const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
dotenv.config();

puppeteerExtra.use(StealthPlugin());
const osPlatform = os.platform();

const executablePath = osPlatform.startsWith('win') ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

const CONCURRENT_BROWSERS = 6;
const BATCH_SIZE = 16;
const ALLOW_PROXY = false;

// Add this line instead
const APIKEY = process.env['2CAPTCHA_API_KEY'];

// Optionally add a check to ensure the API key exists
if (!APIKEY) {
    throw new Error('2CAPTCHA_API_KEY is not set in environment variables');
}

// Define constant user agent to use throughout the app
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Add this as a global variable after the ResultTracker class
const resultTracker = new ResultTracker();

// Add this at the top level of the file, after other constants
let currentChromeDataDirIndex = 0;

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



// Modify extractCapchaTokens function
async function extractCapchaTokens() {
    let shouldContinue = true;

    while (shouldContinue) {
        try {
            // Launch browsers with unique data directories
            const browsers = await Promise.all(
                Array.from({ length: CONCURRENT_BROWSERS }, async (_, index) => {
                    // Delay each browser launch by index * 1000ms
                    await new Promise(resolve => setTimeout(resolve, index * 1000));

                    currentChromeDataDirIndex = (currentChromeDataDirIndex % 20) + 1;
                    const chromeDataDir = `./chrome-user-data/chrome-user-data-${currentChromeDataDirIndex}`;
                    return launchBrowser(chromeDataDir);
                })
            );

            try {
                const pagePromises = Array(BATCH_SIZE).fill().map(async (_, index) => {
                    const browser = browsers[index % CONCURRENT_BROWSERS];
                    let page = null;

                    try {
                        page = await browser.newPage();
                        await page.setUserAgent(USER_AGENT);
                        await page.setDefaultTimeout(30000);
                        await page.setDefaultNavigationTimeout(30000);

                        if (ALLOW_PROXY) {
                            await page.authenticate({
                                username: process.env.PROXY_USERNAME,
                                password: process.env.PROXY_PASSWORD
                            });
                        }

                        const result = await attemptCaptcha(page);
                        console.log('Captcha result:', result);

                        if (result) {
                            resultTracker.addResult({
                                success: true,
                                status: result.status
                            });
                        } else {
                            resultTracker.addResult({
                                success: false,
                                status: 'ERROR'
                            });
                        }

                        // Print stats immediately after processing each captcha
                        resultTracker.printStats();

                    } catch (error) {
                        resultTracker.addResult({
                            success: false,
                            status: 'ERROR'
                        });
                        console.error('Error processing captcha:', error);
                        // Print stats even after errors
                        resultTracker.printStats();
                    } finally {
                        if (page) {
                            await page.close().catch(err =>
                                console.error('Error closing page:', err)
                            );
                        }
                    }
                });

                await Promise.all(pagePromises);

            } finally {
                // Close browsers
                await Promise.all(browsers.map(browser => browser.close().catch(() => { })));
            }

            shouldContinue = false;

        } catch (error) {
            console.error(`Fatal error:`, error);
            shouldContinue = false;
        }
    }
}

// Update launchBrowser function to remove request interception setup
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

    const browser = await puppeteerExtra.launch({
        headless: true,
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
            `--profile-directory=Profile ${Math.floor(Math.random() * 20) + 1}`,
            ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Set user agent for all new pages
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.setUserAgent(USER_AGENT);
            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);
        }
    });

    return browser;
}

// Update solve2Captcha function to use the new format and include user agent
async function solve2Captcha(sitekey, pageUrl) {
    try {
        console.log('Initiating 2captcha solve request...');

        const taskData = {
            clientKey: APIKEY,
            task: {
                type: "RecaptchaV2TaskProxyless",
                websiteURL: pageUrl,
                websiteKey: sitekey,
                userAgent: USER_AGENT,
                isInvisible: false
            }
        };

        //  console.log('Task data:', JSON.stringify(taskData, null, 2));

        // Create task request
        const createTaskResponse = await axios.post('https://api.2captcha.com/createTask', taskData);

        console.log('Create task response:', createTaskResponse.data);

        if (createTaskResponse.data.errorId !== 0) {
            throw new Error(`Failed to create captcha task: ${createTaskResponse.data.errorDescription}`);
        }

        const taskId = createTaskResponse.data.taskId;
        console.log('Got task ID:', taskId);

        // Poll for the result
        let attempts = 0;
        const maxAttempts = 60;

        while (attempts < maxAttempts) {
            // console.log(`Checking solution status, attempt ${attempts + 1}/${maxAttempts}`);

            await new Promise(resolve => setTimeout(resolve, 10000));

            const resultResponse = await axios.post('https://api.2captcha.com/getTaskResult', {
                clientKey: APIKEY,
                taskId: taskId
            });

            // console.log('Result response:', resultResponse.data);

            if (resultResponse.data.status === 'ready') {
                console.log('Solution found!');
                return resultResponse.data.solution.token;
            }

            attempts++;
        }

        throw new Error('Timeout waiting for captcha solution');
    } catch (error) {
        console.error('Error in solve2Captcha:', error);
        throw error;
    }
}

// Add this new function for finding captcha frame
async function findCaptchaFrame(page, timeout = 10000) {
    try {
        // Wait for the frame to be attached
        const frame = await page.waitForFrame(frame =>
            frame.url().includes('api2/anchor'),
            { timeout }
        );

        console.log(clc.cyan('[Captcha] Found anchor frame'));

        // Wait for the checkbox to be ready
        const checkbox = await frame.waitForSelector('.recaptcha-checkbox-border', {
            visible: true,
            timeout
        });

        // Verify the checkbox is actually clickable
        const isClickable = await frame.evaluate(() => {
            const checkbox = document.querySelector('.recaptcha-checkbox-border');
            if (!checkbox) return false;

            const style = window.getComputedStyle(checkbox);
            return !checkbox.disabled &&
                style.visibility !== 'hidden' &&
                style.display !== 'none';
        });

        if (!isClickable) {
            console.log(clc.red('[Captcha] Checkbox found but not clickable'));
            return null;
        }

        console.log(clc.green('[Captcha] Checkbox is ready'));
        return { frame, checkbox };

    } catch (error) {
        console.error(clc.red('[Captcha] Error finding captcha:'), error.message);
        return null;
    }
}

// Update the solveCaptchaChallenge function
async function solveCaptchaChallenge(page) {
    try {
        // Use the frame detection method
        const captchaElements = await findCaptchaFrame(page);
        if (!captchaElements) {
            console.log(clc.red('[Captcha] Failed to find captcha elements'));
            return null;
        }

        // Extract sitekey directly from the frame URL
        const frameUrl = captchaElements.frame.url();
        const sitekey = new URL(frameUrl).searchParams.get('k');

        console.log('Sitekey found in frame URL:', sitekey);

        if (!sitekey) {
            console.log(clc.red('[Captcha] Could not find reCAPTCHA sitekey in frame URL'));
            return null;
        }

        const pageUrl = page.url();
        console.log('Using page URL:', pageUrl);
        console.log('Using sitekey:', sitekey);

        try {
            // Get solution from 2captcha
            const solution = await solve2Captcha(sitekey, pageUrl);
            console.log('Got solution from 2captcha:', clc.yellow(solution.slice(0, 50) + '...'));

            // Insert the solution
            await page.evaluate((token) => {
                document.querySelector('#g-recaptcha-response').value = token;
                document.querySelector('#g-recaptcha-response').style.display = 'block';

                try {
                    window.___grecaptcha_cfg.clients[0].K.K.callback(token);
                } catch (e) {
                    const form = document.querySelector('form');
                    if (form) form.submit();
                }
            }, solution);

            return solution;

        } catch (error) {
            console.error('Error solving captcha with 2captcha:', error);
            return null;
        }
    } catch (error) {
        console.error('Error in solveCaptchaChallenge:', error);
        return null;
    }
}

// Update the attemptCaptcha function
async function attemptCaptcha(page) {
    try {
        console.log(`Loading demo page...`);
        await page.goto('https://www.google.com/recaptcha/api2/demo', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // Start timing
        const captchaStartTime = Date.now();

        // Solve captcha using existing method
        console.log('Attempting to solve captcha...');
        const solvedToken = await solveCaptchaChallenge(page);

        if (solvedToken) {
            const captchaSolveTime = (Date.now() - captchaStartTime) / 1000;
            console.log(`Successfully solved captcha in ${captchaSolveTime.toFixed(2)} seconds`);

            return {
                status: 'SUCCESS',
                token: solvedToken
            };
        }

        console.log('Failed to solve captcha');
        return null;

    } catch (error) {
        console.error(clc.red(`Error processing captcha:`), clc.red(error));
        return null;
    }
}

// Remove the Express server code at the bottom and replace with:
if (require.main === module) {
    extractCapchaTokens().catch(error => {
        console.error('Fatal error in captcha processing:', error);
    });
} else {
    module.exports = extractCapchaTokens;
}