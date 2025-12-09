require('dotenv').config();
const express = require('express');
const unifiedLogin = require('./lib/unifiedLogin');

const app = express();
const port = 7200;

// --- Persistent Browser State ---
let browserPage = null;
let isBrowserBusy = false; // Lock to prevent concurrent operations on the browser

/**
 * Checks if the current browser session is still valid.
 * @param {import('puppeteer').Page} page The Puppeteer page object.
 * @returns {Promise<boolean>} True if the session is valid.
 */
async function isSessionValid(page) {
    if (!page || page.isClosed()) {
        console.log('Session check: Page is null or closed.');
        return false;
    }
    console.log('Session check: Navigating to test URL...');
    const testUrl = 'https://ekamblr.vvmvp.org/ekam/index.php/events/report/event/load/all/all/20250101/20250102/1';
    try {
        const response = await page.goto(testUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        const finalUrl = page.url();
        console.log(`Session check: Final URL is ${finalUrl}`);
        
        // If the URL is the login page, the session is invalid.
        if (finalUrl.includes('signin')) {
            console.log('Session check: FAILED. Redirected to login.');
            return false;
        }
        
        // Also check if we got a valid response status
        if (!response.ok()) {
             console.log(`Session check: FAILED. Status ${response.status()}`);
             return false;
        }

        console.log(`Session check: SUCCESS. Status: ${response.status()}`);
        return true;
    } catch (error) {
        console.error('Session check: An error occurred during navigation:', error.message);
        return false;
    }
}

/**
 * Ensures a valid browser page exists (logging in if necessary) and returns it.
 * MUST be called within a locked context (isBrowserBusy = true).
 */
async function getValidPage() {
    // 1. Check if the current session is valid
    if (await isSessionValid(browserPage)) {
        return browserPage;
    }

    console.log('Session is invalid or does not exist. Creating a new one.');
    
    // Close the old browser if it exists
    if (browserPage) {
        try {
            if (!browserPage.isClosed()) await browserPage.browser().close();
        } catch (e) {
            console.error('Error closing old browser:', e);
        }
        browserPage = null;
    }
    
    // 2. Log in and get a new page object
    try {
        browserPage = await unifiedLogin();
        if (!browserPage) {
            throw new Error('unifiedLogin() did not return a page object.');
        }
        console.log('Successfully created a new browser session.');
        return browserPage;
    } catch (loginError) {
        console.error('FATAL: unifiedLogin() failed.', loginError);
        browserPage = null; 
        throw loginError;
    }
}

/**
 * wrapper to safely execute actions on the persistent browser.
 * Handles locking and session restoration.
 */
async function executeWithPage(actionCallback) {
    // Wait if the browser is already being used by another request
    if (isBrowserBusy) {
        console.log('Browser is busy, waiting...');
        const waitForBrowser = () => new Promise(resolve => {
            const interval = setInterval(() => {
                if (!isBrowserBusy) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
        await waitForBrowser();
    }

    isBrowserBusy = true;

    try {
        const page = await getValidPage();
        return await actionCallback(page);
    } catch (error) {
        console.error('Error executing action with page:', error);
        throw error;
    } finally {
        isBrowserBusy = false;
    }
}


app.get('/ping', (req, res) => {
  console.log('PING hit');
  res.send('pong');
});

app.get('/get-report', (req, res) => {
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
        return res.status(400).send('fromDate and toDate query parameters are required (format YYYYMMDD).');
    }
    const url = `https://ekamblr.vvmvp.org/ekam/index.php/events/report/event/load/all/all/${fromDate}/${toDate}/1`;
    console.log(`Redirecting to /fetch-html for report: ${url}`);
    res.redirect(`/fetch-html?url=${encodeURIComponent(url)}`);
});

app.get('/fetch-html', async (req, res) => {
    console.log("fetch request");
    const { url } = req.query;
    if (!url) {
        return res.status(400).send('URL query parameter is required.');
    }

    try {
        const html = await executeWithPage(async (page) => {
            console.log(`Navigating to requested URL: ${url}`);
            const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
            
            if (!response.ok()) {
                throw new Error(`Failed to fetch URL. Status: ${response.status()}`);
            }
            return await page.content();
        });
        res.send(html);
    } catch (error) {
        console.error('Request failed:', error.message);
        res.status(500).send(`Request failed: ${error.message}`);
    }
});

/**
 * Returns the current session cookies in JSON format.
 * Useful if the Google Script wants to make direct HTTP requests.
 */
app.get('/get-cookie', async (req, res) => {
    console.log("cookie request");
    try {
        const cookies = await executeWithPage(async (page) => {
            return await page.cookies();
        });
        
        const sessionCookie = cookies.find(c => c.name.includes('PHPSESSID'));
        if (sessionCookie) {
            res.json({
                success: true,
                sessionId: sessionCookie.value,
                cookies: cookies
            });
        } else {
            res.status(500).json({ success: false, error: 'Session cookie not found.' });
        }
    } catch (error) {
        console.error('Cookie request failed:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server with PERSISTENT BROWSER session running at http://0.0.0.0:${port}`);
});