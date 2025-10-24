const axios = require('axios');

const testApiWithCookie = async (sessionId) => {
    if (!sessionId) {
        console.error('Error: Please provide a PHPSESSID value as a command-line argument.');
        console.log('Usage: node examples/testApi.js <PHPSESSID_VALUE>');
        return;
    }

    const cookie = `PHPSESSID=${sessionId}`;
    const testUrl = 'https://ekamblr.vvmvp.org/ekam/index.php/events/report/event/load/all/all/20250101/20250102/1';

    console.log(`[DEBUG] Testing API with cookie: ${cookie}`);
    console.log(`   - URL: ${testUrl}`);

    try {
        const response = await axios.get(testUrl, {
            headers: {
                'Cookie': cookie,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'upgrade-insecure-requests': '1',
                'sec-ch-ua': '"Google Chrome";v="141", " Not;A Brand";v="99", "Chromium";v="141"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Mac OS X"'
            },
            maxRedirects: 0,
            validateStatus: (status) => {
                return status >= 200 && status < 500;
            }
        });

        console.log(`[DEBUG] Response Status: ${response.status}`);

        if (response.status === 200) {
            const pageContent = response.data;
            if (pageContent.includes('<title>Login - VVMVP-EKAM</title>')) {
                console.log('   - ❌ FAILED: Session is invalid, server returned login page content.');
            } else {
                console.log('   - ✅ SUCCESS: Cookie is valid, accessed API content.');
                const tableRegex = /<table border=1>([\s\S]*?)<\/table>/i;
                const tableMatch = pageContent.match(tableRegex);
                if (tableMatch) {
                    console.log('   - ✅ Found the events table in the response.');
                } else {
                    console.log('   - ❌ Could not find the events table in the response.');
                }
            }
        } else if (response.status === 302 || response.status === 301) {
            console.log(`   - ❌ FAILED: Session is invalid, server responded with a redirect to ${response.headers.location}`);
        } else {
            console.log(`   - ❌ FAILED: Received an unexpected status code: ${response.status}`);
        }

    } catch (error) {
        console.error('An error occurred during the API test:', error.message);
    }
};

if (require.main === module) {
    const sessionId = process.argv[2];
    testApiWithCookie(sessionId);
}
