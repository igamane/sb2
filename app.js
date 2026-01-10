import { OpenAI } from 'openai';
import fs from 'fs';
import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import cron from 'node-cron';
import dotenv from 'dotenv';
import http from 'http';
import Twitter from 'twitter-lite';
import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import { TwitterApi } from 'twitter-api-v2';
import { twitterClient } from './twitterClient.js';
import fal from '@fal-ai/serverless-client';

fal.config({
  credentials: process.env.FAL_API_KEY
});

dotenv.config();

const SHOP_URL = process.env.SHOP_URL;
const BLOG_ID = process.env.BLOG_ID; 
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 
let articlesPerDay = process.env.ARTICLES_PER_DAY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize OpenAI with your API key
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============= MAILCHIMP NEWSLETTER SETTINGS =============
const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const NEWSLETTER_ENABLED = process.env.NEWSLETTER_ENABLED === 'true';
const NEWSLETTER_SEND_MODE = process.env.NEWSLETTER_SEND_MODE || 'draft'; // 'draft', 'test', or 'live'
const NEWSLETTER_TEST_EMAILS = process.env.NEWSLETTER_TEST_EMAILS || ''; // comma-separated
const NEWSLETTER_FROM_NAME = process.env.NEWSLETTER_FROM_NAME || 'RunV';
const NEWSLETTER_REPLY_TO = process.env.NEWSLETTER_REPLY_TO || '';

// Brand customization for newsletter template
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || 'https://runv.app/wp-content/uploads/2025/06/runV-8-1.png';
const BRAND_PRIMARY_COLOR = process.env.BRAND_PRIMARY_COLOR || '#2BEBE2';
const BRAND_CTA_COLOR = process.env.BRAND_CTA_COLOR || '#FE6F28';
const BRAND_WEBSITE_URL = process.env.BRAND_WEBSITE_URL || 'https://runv.app';
const BRAND_INSTAGRAM_URL = process.env.BRAND_INSTAGRAM_URL || '';
const BRAND_FACEBOOK_URL = process.env.BRAND_FACEBOOK_URL || '';
const BRAND_TAGLINE = process.env.BRAND_TAGLINE || 'Your Running & Fitness Update';

// ============= MAILCHIMP API FUNCTIONS =============

/**
 * Get Mailchimp data center from API key
 */
function getMailchimpDC(apiKey) {
  const parts = apiKey.split('-');
  return parts[1] || 'us1';
}

/**
 * Make Mailchimp API request
 */
async function mailchimpApiRequest(endpoint, method = 'GET', data = null) {
  if (!MAILCHIMP_API_KEY) {
    console.error('Mailchimp API key not configured');
    return { error: 'Mailchimp API key not configured' };
  }

  const dc = getMailchimpDC(MAILCHIMP_API_KEY);
  const url = `https://${dc}.api.mailchimp.com/3.0${endpoint}`;
  
  console.log(`Mailchimp API Request - ${method} ${url}`);

  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64'),
    'Content-Type': 'application/json'
  };

  const options = {
    method,
    headers
  };

  if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
    options.body = JSON.stringify(data);
    console.log('Request body:', JSON.stringify(data).substring(0, 300) + '...');
  }

  try {
    const response = await fetch(url, options);
    const statusCode = response.status;
    
    // Handle empty response (success for some actions like test send)
    const text = await response.text();
    if (!text && statusCode >= 200 && statusCode < 300) {
      console.log('Empty response with success status - operation completed');
      return { success: true, status_code: statusCode };
    }

    const result = text ? JSON.parse(text) : {};
    result._http_status = statusCode;
    
    console.log(`Mailchimp API Response (HTTP ${statusCode}):`, JSON.stringify(result).substring(0, 500));
    
    return result;
  } catch (error) {
    console.error('Mailchimp API Error:', error.message);
    return { error: error.message };
  }
}

/**
 * Generate newsletter body content using AI
 */
async function generateNewsletterBodyWithAI(title, content) {
  // Truncate content to avoid token limits
  const truncatedContent = content.substring(0, 3000);
  
  // Get current day and time context for personalized intro
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  const dayOfWeek = days[now.getDay()];
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
  const month = months[now.getMonth()];
  
  // Random greeting styles for diversity
  const greetingStyles = {
    'casual_friend': 'like texting a running buddy',
    'enthusiastic_coach': 'like an excited running coach',
    'warm_neighbor': 'like a friendly neighbor who loves running',
    'fellow_runner': 'like a fellow runner sharing exciting news',
    'motivational': 'like a supportive teammate cheering you on'
  };
  const styleKeys = Object.keys(greetingStyles);
  const randomStyleKey = styleKeys[Math.floor(Math.random() * styleKeys.length)];
  const randomStyle = greetingStyles[randomStyleKey];

  const prompt = `You are writing a newsletter email for ${NEWSLETTER_FROM_NAME}, a running and fitness brand.

Article Title: ${title}

Article Content Summary:
${truncatedContent}

Current Context: It's ${dayOfWeek} ${timeOfDay} in ${month}.

Write the newsletter with TWO parts:

**PART 1 - PERSONAL INTRO (VERY IMPORTANT):**
Write a warm, informal greeting that sounds ${randomStyle}. This intro should:
- Start with a casual, friendly greeting (NOT "Dear subscriber" - think "Hey there!" or "Hi friend!" or "Happy ${dayOfWeek}!")
- Be 2-3 sentences max
- Sound genuinely human and conversational
- Can reference the day/week/season naturally
- Build excitement for what's coming
- DO NOT use the subscriber's name (we don't have it)
- VARY your greeting style - don't always use the same opening!

Example intros (use as inspiration, don't copy exactly):
- "Hey there, runner! 👋 Hope your week's been treating you well..."
- "Happy ${dayOfWeek}! Got something exciting to share with you today..."
- "Hi friend! Quick pause from your busy day for some running goodness..."

**PART 2 - MAIN CONTENT:**
After the intro, write the main newsletter body that:
1. Transitions naturally from the intro
2. Highlights 2-3 key takeaways from the article
3. Creates curiosity without giving everything away
4. Ends with a teaser that encourages clicking "Read Full Article"
5. Uses a friendly, energetic tone

Total length: 120-180 words (including intro).

Format as clean HTML with <p> tags. Do NOT include the article title as a heading, header, or any buttons - just the intro and body content.
Do NOT use bullet points or lists - write in flowing paragraph style.
IMPORTANT: Return ONLY the HTML content without any code fences (no \`\`\`html or \`\`\` markers). Just return the raw HTML directly.

Write the newsletter now:`;

  try {
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o',
    });

    let newsletterBody = completion.choices[0].message.content || '';
    
    // Remove code fences (```html and ```)
    newsletterBody = newsletterBody.replace(/```html|```/g, '');
    
    // Remove any markdown code block markers
    newsletterBody = newsletterBody.replace(/```[\s\S]*?```/g, '');
    
    // Ensure it has paragraph tags
    if (!newsletterBody.includes('<p>')) {
      newsletterBody = '<p>' + newsletterBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
    
    // Style the paragraphs
    newsletterBody = newsletterBody.replace(/<p>/g, '<p style="color: #666666; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">');
    
    console.log(`Generated newsletter body (${newsletterBody.length} chars)`);
    return newsletterBody;
  } catch (error) {
    console.error('Newsletter body generation failed:', error.message);
    return null;
  }
}

/**
 * Generate newsletter subject line
 */
function generateNewsletterSubject(title) {
  const prefixes = ['📖 New Post:', '✨ Fresh Content:', '🎯 Just Published:', '💪 New Article:', '🏃 Running Update:'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  
  // Trim title to ~8 words
  const words = title.split(' ').slice(0, 8).join(' ');
  return `${prefix} ${words}`;
}

/**
 * Generate newsletter HTML content
 */
async function generateNewsletterHTML(title, content, featuredImageUrl, articleUrl) {
  // Generate AI-powered newsletter content
  let newsletterBody = await generateNewsletterBodyWithAI(title, content);
  
  if (!newsletterBody) {
    // Fallback to simple excerpt if AI fails
    const excerpt = content.replace(/<[^>]*>/g, '').substring(0, 300);
    newsletterBody = `<p style="color: #666666; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">${excerpt}...</p>`;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td style="padding: 20px;">
                <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header with Branding -->
                    <tr>
                        <td style="background-color: ${BRAND_PRIMARY_COLOR}; padding: 25px 30px; text-align: center;">
                            <img src="${BRAND_LOGO_URL}" alt="${NEWSLETTER_FROM_NAME}" style="max-width: 180px; height: auto; display: inline-block;">
                            <p style="color: #ffffff; margin: 12px 0 0 0; font-size: 14px; text-shadow: 0 1px 2px rgba(0,0,0,0.2);">${BRAND_TAGLINE}</p>
                        </td>
                    </tr>
                    
                    <!-- Featured Image -->
                    ${featuredImageUrl ? `<tr>
                        <td>
                            <img src="${featuredImageUrl}" alt="${title}" style="width: 100%; height: auto; display: block;">
                        </td>
                    </tr>` : ''}
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 30px;">
                            <h2 style="color: #1a1a2e; margin: 0 0 15px 0; font-size: 24px; line-height: 1.3;">${title}</h2>
                            ${newsletterBody}
                            <div style="margin-top: 25px;">
                                <a href="${articleUrl}" style="display: inline-block; background-color: ${BRAND_CTA_COLOR}; color: #ffffff; padding: 14px 35px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">Read Full Article →</a>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: ${BRAND_PRIMARY_COLOR}; padding: 30px 20px;">
                            <!-- Logo -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="text-align: center;">
                                        <img src="${BRAND_LOGO_URL}" alt="${NEWSLETTER_FROM_NAME}" style="height: 35px; width: auto;">
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Navigation Links -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="text-align: center;">
                                        <a href="${BRAND_WEBSITE_URL}" style="color: #ffffff; text-decoration: none; font-size: 14px; margin: 0 15px;">Website</a>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Social Icons -->
                            ${(BRAND_INSTAGRAM_URL || BRAND_FACEBOOK_URL) ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="text-align: center;">
                                        ${BRAND_INSTAGRAM_URL ? `<a href="${BRAND_INSTAGRAM_URL}" style="display: inline-block; margin: 0 8px;">
                                            <img src="https://cdn-icons-png.flaticon.com/512/174/174855.png" alt="Instagram" style="width: 28px; height: 28px;">
                                        </a>` : ''}
                                        ${BRAND_FACEBOOK_URL ? `<a href="${BRAND_FACEBOOK_URL}" style="display: inline-block; margin: 0 8px;">
                                            <img src="https://cdn-icons-png.flaticon.com/512/124/124010.png" alt="Facebook" style="width: 28px; height: 28px;">
                                        </a>` : ''}
                                    </td>
                                </tr>
                            </table>` : ''}
                            
                            <!-- Unsubscribe -->
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="text-align: center;">
                                        <p style="color: #ffffff; font-size: 11px; margin: 0;">
                                            You're receiving this because you subscribed to ${NEWSLETTER_FROM_NAME} updates.<br>
                                            <a href="*|UNSUB|*" style="color: #ffffff; text-decoration: underline;">Unsubscribe</a>
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  return html;
}

/**
 * Generate and send newsletter for a published article
 */
async function generateAndSendNewsletter(title, content, featuredImageUrl, articleUrl) {
  console.log('========================================');
  console.log('STARTING NEWSLETTER GENERATION');
  console.log('Article:', title);
  console.log('========================================');

  if (!NEWSLETTER_ENABLED) {
    console.log('Newsletter is disabled - skipping');
    return false;
  }

  if (!MAILCHIMP_API_KEY) {
    console.error('ERROR - Mailchimp API key not configured');
    return false;
  }

  if (!MAILCHIMP_AUDIENCE_ID) {
    console.error('ERROR - Mailchimp audience ID not configured');
    return false;
  }

  console.log(`Newsletter settings - Mode: ${NEWSLETTER_SEND_MODE}, From: ${NEWSLETTER_FROM_NAME}`);

  // Generate newsletter content
  const newsletterHtml = await generateNewsletterHTML(title, content, featuredImageUrl, articleUrl);
  const subjectLine = generateNewsletterSubject(title);
  
  // Strip HTML for preview text
  const previewText = content.replace(/<[^>]*>/g, '').substring(0, 100);

  console.log('Generated newsletter content:');
  console.log('- Subject:', subjectLine);
  console.log('- HTML length:', newsletterHtml.length, 'characters');

  if (!newsletterHtml || newsletterHtml.length < 100) {
    console.error('ERROR - Newsletter HTML is empty or too short!');
    return false;
  }

  // Create campaign
  const campaignData = {
    type: 'regular',
    recipients: {
      list_id: MAILCHIMP_AUDIENCE_ID
    },
    settings: {
      subject_line: subjectLine,
      preview_text: previewText,
      title: 'Newsletter: ' + title.substring(0, 50),
      from_name: NEWSLETTER_FROM_NAME,
      reply_to: NEWSLETTER_REPLY_TO || 'noreply@example.com',
      auto_footer: true
    }
  };

  console.log('Creating Mailchimp campaign...');
  const campaign = await mailchimpApiRequest('/campaigns', 'POST', campaignData);

  if (campaign.error || campaign.detail || (campaign._http_status && campaign._http_status >= 400)) {
    console.error('ERROR creating campaign:', JSON.stringify(campaign));
    return false;
  }

  if (!campaign.id) {
    console.error('ERROR - No campaign ID in response:', JSON.stringify(campaign));
    return false;
  }

  const campaignId = campaign.id;
  console.log('SUCCESS - Created Mailchimp campaign:', campaignId);

  // Set campaign content
  console.log('Setting campaign content...');
  const contentResult = await mailchimpApiRequest(`/campaigns/${campaignId}/content`, 'PUT', {
    html: newsletterHtml
  });

  if (contentResult.error || contentResult.detail || (contentResult._http_status && contentResult._http_status >= 400)) {
    console.error('ERROR setting campaign content:', JSON.stringify(contentResult));
    return false;
  }

  console.log('SUCCESS - Campaign content set!');

  // Handle send mode
  if (NEWSLETTER_SEND_MODE === 'live') {
    console.log('Sending to ALL subscribers (live mode)...');
    const sendResult = await mailchimpApiRequest(`/campaigns/${campaignId}/actions/send`, 'POST');

    if (sendResult.error || sendResult.detail || (sendResult._http_status && sendResult._http_status >= 400)) {
      console.error('ERROR sending:', JSON.stringify(sendResult));
      return false;
    }

    console.log('SUCCESS - Newsletter sent to all subscribers!');
    return true;

  } else if (NEWSLETTER_SEND_MODE === 'test') {
    // Send to test emails only
    const testEmailArray = NEWSLETTER_TEST_EMAILS.split(',').map(e => e.trim()).filter(e => e);

    if (testEmailArray.length === 0) {
      console.error('ERROR - No test emails configured! Please add NEWSLETTER_TEST_EMAILS in env.');
      return false;
    }

    console.log('Test mode - sending to:', testEmailArray.join(', '));
    console.log('NOTE: Mailchimp will automatically add "THIS IS A TEST MESSAGE" to test emails.');
    console.log('To avoid this, use NEWSLETTER_SEND_MODE=draft and send manually from Mailchimp dashboard.');

    const testResult = await mailchimpApiRequest(`/campaigns/${campaignId}/actions/test`, 'POST', {
      test_emails: testEmailArray,
      send_type: 'html'
    });

    if (testResult.error || testResult.detail || (testResult._http_status && testResult._http_status >= 400)) {
      console.error('ERROR sending test:', JSON.stringify(testResult));
      return false;
    }

    console.log('========================================');
    console.log('SUCCESS - Test newsletter sent!');
    console.log('Sent to:', testEmailArray.join(', '));
    console.log('Campaign ID:', campaignId);
    console.log('NOTE: "THIS IS A TEST MESSAGE" is automatically added by Mailchimp - cannot be removed via API');
    console.log('Check inbox AND spam folder!');
    console.log('========================================');
    return true;

  } else {
    // Draft mode - just save
    console.log('Draft mode - Newsletter saved as draft');
    console.log('Campaign ID:', campaignId);
    console.log('Log into Mailchimp to review and send manually.');
    return true;
  }
}

// Insert product promotion banners
function insertProductPromotion(htmlContent) {
  const { window } = new JSDOM(htmlContent);
  const { document } = window;

  const products = [];
  if (process.env.AFTER_OUTLINE_PRODUCT_LINK && process.env.AFTER_OUTLINE_PRODUCT_IMAGE) {
    products.push({ link: process.env.AFTER_OUTLINE_PRODUCT_LINK, image: process.env.AFTER_OUTLINE_PRODUCT_IMAGE, position: "AFTER_OUTLINE" });
  }
  if (process.env.MIDDLE_PRODUCT_LINK && process.env.MIDDLE_PRODUCT_IMAGE) {
    products.push({ link: process.env.MIDDLE_PRODUCT_LINK, image: process.env.MIDDLE_PRODUCT_IMAGE, position: "MIDDLE" });
  }
  if (process.env.END_PRODUCT_LINK && process.env.END_PRODUCT_IMAGE) {
    products.push({ link: process.env.END_PRODUCT_LINK, image: process.env.END_PRODUCT_IMAGE, position: "END" });
  }

  products.forEach(product => {
    const clickableImage = `<a href="${product.link}" target="_blank" rel="noopener"><img src="${product.image}" alt="Product Promotion" style="width:100%;height:auto;"></a>`;
    if (product.position === "AFTER_OUTLINE") {
      const firstULElement = document.querySelector("ul");
      if (firstULElement) firstULElement.insertAdjacentHTML("afterend", clickableImage);
    } else if (product.position === "MIDDLE") {
      const pElements = document.querySelectorAll("p");
      const middleIndex = Math.floor(pElements.length / 2);
      if (pElements[middleIndex]) pElements[middleIndex].insertAdjacentHTML("afterend", clickableImage);
    } else if (product.position === "END") {
      const lastElement = document.body.lastElementChild;
      if (lastElement) lastElement.insertAdjacentHTML("afterend", clickableImage);
    }
  });

  return document.documentElement.innerHTML;
}

// ============= INTERNAL LINKS =============
/**
 * Fetch existing blog articles from Shopify for internal linking
 */
async function getAvailableInternalLinks(maxLinks = 20) {
  const apiVersion = '2023-10';
  const articlesUrl = `${SHOP_URL}/admin/api/${apiVersion}/blogs/${BLOG_ID}/articles.json?limit=${maxLinks}&published_status=published`;
  
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': ACCESS_TOKEN,
  };

  try {
    const response = await fetch(articlesUrl, { headers });
    const data = await response.json();
    
    if (!data.articles || data.articles.length === 0) {
      console.log('No existing articles found for internal linking');
      return [];
    }
    
    // Get the shop domain for building URLs
    const shopDomain = process.env.SHOP_DOMAIN || SHOP_URL.replace('https://', '').replace('.myshopify.com', '.com');
    const blogHandle = process.env.BLOG_HANDLE || 'news';
    
    const internalLinks = data.articles.map(article => ({
      url: `https://${shopDomain}/blogs/${blogHandle}/${article.handle}`,
      title: article.title
    }));
    
    // Shuffle and limit
    const shuffled = internalLinks.sort(() => Math.random() - 0.5);
    console.log(`Found ${shuffled.length} internal links available`);
    
    return shuffled.slice(0, maxLinks);
  } catch (error) {
    console.error('Error fetching internal links:', error.message);
    return [];
  }
}

/**
 * Format internal links for AI prompt
 */
function formatInternalLinksForAI(internalLinks) {
  if (!internalLinks || internalLinks.length === 0) {
    return '';
  }
  
  let formatted = "INTERNAL LINKS TO USE (choose 3 that fit naturally with your content):\n";
  internalLinks.forEach((link, index) => {
    formatted += `${index + 1}. "${link.title}" - ${link.url}\n`;
  });
  
  return formatted;
}

// ============= EXTERNAL LINKS =============
/**
 * Find external links using OpenAI with web search
 */
async function findExternalLinksWithAI(focusKeyword) {
  console.log('Searching for external links related to:', focusKeyword);
  
  const prompt = `Search the web for authoritative, high-quality articles related to: "${focusKeyword}"

Find 3 real, existing web pages from reputable sources (NOT Wikipedia) such as:
- Major running/fitness publications (Runner's World, Running Magazine, etc.)
- Sports news sites (ESPN, Sports Illustrated, etc.)
- Health/fitness sites (Healthline, WebMD, etc.)
- Technology review sites (for running tech topics)
- Official brand/manufacturer websites

For each link, provide:
1. The exact, full URL (must be a real, working link)
2. A short anchor text (2-5 words) that describes what the link is about

IMPORTANT: Return ONLY valid JSON in this exact format, nothing else:
[
  {"url": "https://example.com/article", "text": "Anchor text here"},
  {"url": "https://example.com/article2", "text": "Another anchor"}
]

Return ONLY the JSON array, no explanation or other text.`;

  try {
    // Try with web search using responses API
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.1',
        tools: [{ type: 'web_search' }],
        input: prompt
      })
    });

    if (!response.ok) {
      console.log('Web search API failed, using fallback');
      return await findExternalLinksFallback(focusKeyword);
    }

    const data = await response.json();
    
    // Extract text from response
    let responseText = '';
    if (data.output) {
      for (const item of data.output) {
        if (item.content) {
          for (const content of item.content) {
            if (content.text) {
              responseText += content.text;
            }
          }
        }
      }
    } else if (data.choices?.[0]?.message?.content) {
      responseText = data.choices[0].message.content;
    }

    const links = parseExternalLinksJson(responseText);
    
    if (links.length === 0) {
      console.log('Could not parse links from web search, using fallback');
      return await findExternalLinksFallback(focusKeyword);
    }
    
    return links;
  } catch (error) {
    console.error('Error finding external links:', error.message);
    return await findExternalLinksFallback(focusKeyword);
  }
}

/**
 * Fallback: Find external links without web search
 */
async function findExternalLinksFallback(focusKeyword) {
  console.log('Using fallback for external links');
  
  const prompt = `You are an expert on running, fitness, and sports.

For the topic "${focusKeyword}", suggest 3 authoritative external websites that would have relevant content. 

Choose from well-known sources like:
- runnersworld.com
- active.com  
- verywellfit.com
- outsideonline.com
- trainingpeaks.com
- strava.com/blog
- podiumrunner.com

Return ONLY valid JSON in this exact format:
[
  {"url": "https://www.runnersworld.com/", "text": "Runner's World"},
  {"url": "https://www.active.com/running", "text": "Active Running"}
]

Return ONLY the JSON array.`;

  try {
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-5.1',
    });

    const responseText = completion.choices[0].message.content || '';
    return parseExternalLinksJson(responseText);
  } catch (error) {
    console.error('Fallback external links also failed:', error.message);
    return [];
  }
}

/**
 * Parse JSON array of links from AI response
 */
function parseExternalLinksJson(responseText) {
  const links = [];
  
  // Try to extract JSON array from response
  const match = responseText.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.url && item.text) {
            const url = item.url.trim();
            // Validate URL
            if (url.startsWith('http://') || url.startsWith('https://')) {
              links.push({
                url: url,
                text: item.text.trim()
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Error parsing external links JSON:', e.message);
    }
  }
  
  console.log(`Parsed ${links.length} valid external links`);
  return links;
}

/**
 * Add external links to article content
 */
function addExternalLinks(htmlContent, externalLinks) {
  if (!externalLinks || externalLinks.length === 0) {
    return htmlContent;
  }

  const { window } = new JSDOM(htmlContent);
  const { document } = window;
  
  const paragraphs = document.querySelectorAll('p');
  const paragraphCount = paragraphs.length;
  
  if (paragraphCount < 3) {
    console.log('Not enough paragraphs for external links');
    return htmlContent;
  }
  
  let linksAdded = 0;
  const maxLinks = Math.min(2, externalLinks.length);
  
  // Add external links to middle paragraphs (at 40% and 70% positions)
  const linkPositions = [
    Math.floor(paragraphCount * 0.4),
    Math.floor(paragraphCount * 0.7)
  ];
  
  for (let i = 0; i < linkPositions.length && linksAdded < maxLinks; i++) {
    const pos = linkPositions[i];
    if (pos < paragraphCount && externalLinks[linksAdded]) {
      const paragraph = paragraphs[pos];
      if (paragraph) {
        const linkData = externalLinks[linksAdded];
        
        // Create external link with proper attributes
        const link = document.createElement('a');
        link.href = linkData.url;
        link.textContent = linkData.text;
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        
        // Append to paragraph
        paragraph.appendChild(document.createTextNode(' ('));
        paragraph.appendChild(link);
        paragraph.appendChild(document.createTextNode(')'));
        
        linksAdded++;
        console.log('Added external link:', linkData.url);
      }
    }
  }
  
  if (linksAdded > 0) {
    console.log(`Successfully added ${linksAdded} external links`);
  }
  
  return document.documentElement.innerHTML;
}

(async () => {
  const postContent = 'Testing Twitter API with an image upload via twitter-api-v2.';
  const imageUrl = 'https://letsenhance.io/static/8f5e523ee6b2479e26ecc91b9c25261e/1015f/MainAfter.jpg'; // Replace with a valid image URL
  await postToTwitter(postContent, imageUrl);
})();

// Function to rewrite the article content using OpenAI
async function rewriteArticleContent(articleTitle) {
  try {
    // Get available internal links from existing Shopify blog articles
    const internalLinks = await getAvailableInternalLinks(20);
    const internalLinksText = formatInternalLinksForAI(internalLinks);
    
    // Build the prompt with internal links requirement
    let prompt = `write a Running blog article with detailed informations about the topic: \n${articleTitle}\n\n Make it long and more detailed and informative, in HTML format:\n1. without header and footer\n2. the first thing must be an introduction within a paragraph\n3. the second thing is the article outline, with the functionality to jump to sections\n 4. section titles must be within an h2\n5. use lists (ul - ol) to make things clear and organized\n6. highlight improtant things using bold style\n7. optimized for SEO (use relevant tags for the best SEO ranking)\n8. adjust it to be readable and coherent, and make it long with a focus on improving its search engine visibility by strategically integrating relevant keywords. Make sure the revised content maintains a conversational tone and enhances readability by simplifying complex sentences. Additionally, ensure that the information remains accurate and comprehensive while presenting it in a more engaging and coherent manner.\n
              When optimizing for SEO, include relevant keywords in the article while ensuring their natural incorporation. Improve the readability by breaking down long paragraphs, using bullet points where necessary, and ensuring a smooth flow of ideas.`;
    
    // Add internal links requirement if available
    if (internalLinksText) {
      prompt += `\n\nINTERNAL LINKING REQUIREMENT:\nYou MUST include exactly 3 internal links from the list below. Insert them naturally within relevant paragraphs as HTML anchor tags.\nFormat: <a href="URL">anchor text</a>\nChoose links that relate to the content and flow naturally in context.\n\n${internalLinksText}`;
    }
    
    prompt += '\n\n###';
    
    console.log(`Generating article with ${internalLinks.length} internal links available`);
    
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: 'gpt-5.1',
    });

    let rewrittenContent = completion.choices[0].message.content;
    console.log(rewrittenContent);

    // **bold** -> <b>
    rewrittenContent = rewrittenContent.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    // strip code fences
    rewrittenContent = rewrittenContent.replace(/```html|```/g, "");
    // remove {...}
    rewrittenContent = rewrittenContent.replace(/\{[^}]*\}/g, "");

    // Remove <h1> tags and CSS from the HTML content using jsdom
    const { window } = new JSDOM(rewrittenContent);
    const { document } = window;

    // Remove H1
    document.querySelectorAll("h1").forEach((el) => el.remove());
    // Remove CSS
    document.querySelectorAll("style").forEach((el) => el.remove());
    document.querySelectorAll("*").forEach((el) => el.removeAttribute("style"));
    document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove());

    // Get the modified HTML content after removing <h1> tags and CSS
    let htmlContent = document.documentElement.innerHTML;

    // Insert product promotion banners
    htmlContent = insertProductPromotion(htmlContent);
    
    // Add external links using AI web search
    console.log('Adding external links...');
    const externalLinks = await findExternalLinksWithAI(articleTitle);
    htmlContent = addExternalLinks(htmlContent, externalLinks);

    return htmlContent;
  } catch (error) {
    console.error('Error rewriting article content:', error);
    return null;
  }
}

function removeDoubleQuotes(inputString) {
    // Replace double quotes with an empty string
    return inputString.replace(/"/g, '');
}

// Function to generate the meta description using OpenAI
async function generateMetaDescription(articleTitle) {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: `Generate a well-optimized meta description for a Running article about this topic: \n${articleTitle}\n\n. Include relevant keywords and make it SEO-friendly to improve search engine visibility.###`,
        },
      ],
      model: 'gpt-5.1',
    });

    let metaDescription = completion.choices[0].message.content.trim();
    metaDescription = removeDoubleQuotes(metaDescription);
    console.log(metaDescription);

    return metaDescription;
  } catch (error) {
    console.error('Error generating meta description:', error);
    return null;
  }
}
async function generateImageDescription(articleTitle) {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: `Write me a detailed prompt for an AI text to image model for generating a blog article feature image about the topic: \n${articleTitle}\n\n. You must imagine how the image should loop like for this title and describe it in details for this AI, he will just design what you described. Reply and return only the detailed prompt without any other irrelevant text, because your reply will be sent directly to the AI text to image model. The prompt should start with 'Design an eye catching...' and give him a short title to place within the image that will accomplish the article title and explain the title style`,
        },
      ],
      model: 'gpt-5.1',
    });

    let metaDescription = completion.choices[0].message.content.trim();
    console.log(metaDescription);

    return metaDescription;
  } catch (error) {
    console.error('Error generating meta description:', error);
    return null;
  }
}

async function generateArticleTitle() {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: `Generate a long, SEO-friendly Running blog article title within one of these categories: Running. The title must include relevant SEO keywords. Return only the title without any other text and without quotation marks.`,
        },
      ],
      model: 'gpt-5.1',
    });

    let articleTitle = completion.choices[0].message.content.trim();
    articleTitle = removeDoubleQuotes(articleTitle);
    console.log(articleTitle);

    return articleTitle;
  } catch (error) {
    console.error('Error generating article title:', error);
    return null;
  }
}

// Function to generate SEO keywords using OpenAI
async function generateSEOKeywords(articleTitle) {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: `Generate a list of 5 relevant SEO keywords for a Running blog article titled: "${articleTitle}". Return the 5 keywords as a comma-separated string without any additional text.`,
        },
      ],
      model: 'gpt-5.1',
    });

    let seoKeywords = completion.choices[0].message.content.trim();
    seoKeywords = removeDoubleQuotes(seoKeywords);
    console.log('SEO Keywords:', seoKeywords);

    return seoKeywords;
  } catch (error) {
    console.error('Error generating SEO keywords:', error);
    return null;
  }
}

// Function to generate a summary of the article
async function generateArticleSummary(articleTitle, articleContent) {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: `Summarize the following article in a few sentences:\nTitle: ${articleTitle}\nContent: ${articleContent}\n\n###`,
        },
      ],
      model: 'gpt-5.1',
    });

    let summary = completion.choices[0].message.content.trim();
    summary = removeDoubleQuotes(summary);
    console.log('Article Summary:', summary);

    return summary;
  } catch (error) {
    console.error('Error generating article summary:', error);
    return null;
  }
}

// Function to generate social media posts
async function generateSocialMediaPost(platform, articleTitle, articleSummary, articleUrl) {
  let prompt;
  switch(platform) {
    case 'twitter':
      prompt = `Create a concise and engaging tweet for Twitter about the following article:\nTitle: ${articleTitle}\nSummary: ${articleSummary}\n\nInclude a call-to-action to read the full article here: ${articleUrl}. Make sure it's within 280 characters, includes relevant hashtags, and is engaging to readers. Important: Your reply will directly be posted to our Twitter account so reply with just the post content without any addional text also Don't include any placeholder like [article_url]###`;
      break;
    case 'facebook':
      prompt = `Write a Facebook post introducing the following article:\nTitle: ${articleTitle}\nSummary: ${articleSummary}\n\nInclude a call-to-action to read the full article here: ${articleUrl}. Make it engaging and suitable for Facebook audience. Important: Your reply will directly be posted to our Facebook account so reply with just the post content without any addional text also Don't include any placeholder like [article_url]###`;
      break;
    case 'instagram':
      prompt = `Craft an engaging Instagram caption for a post about the following article:\nTitle: ${articleTitle}\nSummary: ${articleSummary}\n\nInclude a call-to-action to read the full article here: ${articleUrl}. Include relevant hashtags and make it engaging. Important: Your reply will directly be posted to our Instagram account so reply with just the post content without any addional text also Don't include any placeholder like [article_url]###`;
      break;
    default:
      console.error('Unsupported platform:', platform);
      return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: 'gpt-5.1',
    });

    let postContent = completion.choices[0].message.content.trim();
    postContent = removeDoubleQuotes(postContent);
    console.log(`Generated ${platform} post:`, postContent);

    return postContent;
  } catch (error) {
    console.error(`Error generating ${platform} post:`, error);
    return null;
  }
}

async function verifyTwitterCredentials() {
  const twitterClient = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  try {
    const response = await twitterClient.get('account/verify_credentials');
    console.log('Twitter credentials are valid.');
  } catch (error) {
    console.error('Twitter credentials are invalid:', error);
  }
}
verifyTwitterCredentials();


// Function to post to Twitter
async function postToTwitter(postContent, imageUrl) {
  // Twitter client for media uploads using 'twitter-lite'
  const twitterLiteClient = new Twitter({
    subdomain: "upload", // Specify 'upload' subdomain for media uploads
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  // Twitter client for posting tweets using 'twitter-api-v2'
  const twitterClientV2 = new TwitterApi({
    appKey: process.env.TWITTER_CONSUMER_KEY,
    appSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN_KEY,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  const rwClient = twitterClientV2.readWrite;

  try {
    // Upload the image using 'twitter-lite'
    let mediaId = null;
    if (imageUrl) {
      // Download the image
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const imageData = Buffer.from(imageResponse.data);

      // Base64 encode the image data
      const base64Image = imageData.toString('base64');

      // Upload the image to Twitter using 'twitter-lite'
      const mediaUpload = await twitterLiteClient.post('media/upload', {
        media_data: base64Image,
      });

      if (mediaUpload.errors) {
        console.error('Twitter Media Upload Errors:', mediaUpload.errors);
        return;
      } else {
        console.log('Media uploaded successfully. Media ID:', mediaUpload.media_id_string);
        mediaId = mediaUpload.media_id_string;
      }
    }

    postContent = postContent.replace(/\[[^\]]+\]\((https?:\/\/[^\s]+?)\)/g, '$1');

    // Prepare the tweet parameters
    const tweetParams = {
      text: postContent,
    };

    if (mediaId) {
      tweetParams.media = { media_ids: [mediaId] };
    }

    // Post the tweet using 'twitter-api-v2'
    await rwClient.v2.tweet(tweetParams);

    console.log('Successfully posted to Twitter.');
  } catch (error) {
    console.error('Error posting to Twitter:', error);
    if (error.data) {
      console.error('Twitter API Response:', error.data);
    } else if (error.errors) {
      console.error('Twitter API Errors:', error.errors);
    } else if (error.response) {
      console.error('Twitter API Response:', error.response.data);
    }
  }
}


// Function to post to Facebook
async function postToFacebook(postContent, imageUrl) {
  // Facebook API credentials
  const facebookPageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const facebookPageId = process.env.FACEBOOK_PAGE_ID;

  try {
    // Prepare the image and post data
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.buffer();

    postContent = postContent.replace(/\[[^\]]+\]\((https?:\/\/[^\s]+?)\)/g, '$1');

    const formData = new FormData();
    formData.append('access_token', facebookPageAccessToken);
    formData.append('message', postContent);
    formData.append('source', imageBuffer, { filename: 'image.jpg' });

    const response = await axios.post(`https://graph.facebook.com/v17.0/${facebookPageId}/photos`, formData, {
      headers: {
        ...formData.getHeaders()
      }
    });

    if (response.data.error) {
      console.error('Error posting to Facebook:', response.data.error);
    } else {
      console.log('Successfully posted to Facebook.');
    }
  } catch (error) {
    console.error('Error posting to Facebook:', error);
  }
}

// Function to post to Instagram
async function postToInstagram(postContent, imageUrl) {
  // Instagram API credentials
  const instagramBusinessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const facebookPageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  try {

    postContent = postContent.replace(/\[[^\]]+\]\((https?:\/\/[^\s]+?)\)/g, '$1');

    // Step 1: Create Media Container
    const createMediaUrl = `https://graph.facebook.com/v17.0/${instagramBusinessAccountId}/media`;

    const params = new URLSearchParams();
    params.append('image_url', imageUrl);
    params.append('caption', postContent);
    params.append('access_token', facebookPageAccessToken);

    const mediaResponse = await axios.post(createMediaUrl, params);

    if (mediaResponse.data.error) {
      console.error('Error creating Instagram media:', mediaResponse.data.error);
      return;
    }

    const creationId = mediaResponse.data.id;

    // Step 2: Publish Media Container
    const publishMediaUrl = `https://graph.facebook.com/v17.0/${instagramBusinessAccountId}/media_publish`;

    const publishParams = new URLSearchParams();
    publishParams.append('creation_id', creationId);
    publishParams.append('access_token', facebookPageAccessToken);

    const publishResponse = await axios.post(publishMediaUrl, publishParams);

    if (publishResponse.data.error) {
      console.error('Error publishing Instagram media:', publishResponse.data.error);
    } else {
      console.log('Successfully posted to Instagram.');
    }
  } catch (error) {
    console.error('Error posting to Instagram:', error.response ? error.response.data : error.message);
  }
}

// Function to generate and post to social media
async function generateAndPostToSocialMedia(articleTitle, articleContent, imageUrl, articleUrl) {
  // Generate a summary of the article to use in social media posts
  const articleSummary = await generateArticleSummary(articleTitle, articleContent);
  if (!articleSummary) {
    console.error('Failed to generate article summary.');
    return;
  }

  // Generate social media posts for each platform
  const platforms = ['twitter', 'facebook', 'instagram'];
  for (const platform of platforms) {
    const postContent = await generateSocialMediaPost(platform, articleTitle, articleSummary, articleUrl);
    if (postContent) {
      switch(platform) {
        case 'twitter':
          await postToTwitter(postContent, imageUrl);
          break;
        case 'facebook':
          await postToFacebook(postContent, imageUrl);
          break;
        case 'instagram':
          await postToInstagram(postContent, imageUrl);
          break;
        default:
          console.error('Unsupported platform:', platform);
      }
    }
  }
}

// Define the sign-up form HTML code
const signUpFormHtml = '<div class="klaviyo-form-R4UQwA"></div>';

// Function to insert the sign-up form into the middle of the content
function insertSignUpForm(htmlContent, signUpFormHtml) {
    // Append the sign-up form HTML to the end of the content
  const modifiedContent = htmlContent + signUpFormHtml;

  return modifiedContent;
}

// Function to create the article on Shopify
async function createArticleOnShopify(title, htmlContent, metaDescription, imageUrl, tags) {
    const modifiedHtmlContent = insertSignUpForm(htmlContent, signUpFormHtml);
  // Article data
  const articleData = {
    article: {
      blog_id: BLOG_ID,
      title: title,
      author: 'author', // Replace with the author name
      body_html: modifiedHtmlContent,
      summary_html: metaDescription,
      published_at: new Date().toISOString(),
      tags: tags, // Include the tags here
      image: {
        src: imageUrl // Include the image URL
      }
    },
  };

  // API endpoint for creating an article
  const apiVersion = '2023-10';
  const createArticleUrl = `${SHOP_URL}/admin/api/${apiVersion}/blogs/${BLOG_ID}/articles.json`;

  // Headers for the request
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': ACCESS_TOKEN,
  };

  try {
    const response = await fetch(createArticleUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(articleData),
    });

    const responseData = await response.json();
    if (response.status === 201) {
      console.log('Article created successfully on Shopify.');
      console.log(responseData);
      const shopDomain = process.env.SHOP_DOMAIN; // Add this to your .env file
      const articleHandle = responseData.article.handle;
      const blogHandle = process.env.BLOG_HANDLE || 'news'; // Replace with your blog's actual handle
      const articleUrl = `https://${shopDomain}/blogs/${blogHandle}/${articleHandle}`;
      console.log('Article URL:', articleUrl);

      // After successfully creating the article, generate and post to social media
      await generateAndPostToSocialMedia(title, htmlContent, imageUrl, articleUrl);

      // Generate and send newsletter via Mailchimp
      if (NEWSLETTER_ENABLED) {
        console.log('Newsletter enabled - generating and sending...');
        await generateAndSendNewsletter(title, htmlContent, imageUrl, articleUrl);
      } else {
        console.log('Newsletter disabled - skipping.');
      }
    } else {
      console.log('Failed to create article on Shopify.');
      console.log('Error:', responseData);
    }
  } catch (error) {
    console.error('Error creating article on Shopify:', error.message);
  }
}

// Function to post an article
async function postArticle(articleTitle) {
  const rewrittenContent = await rewriteArticleContent(articleTitle);
  if (rewrittenContent) {
    const rewrittenTitle = articleTitle;
    if (rewrittenTitle) {
      const metaDescription = await generateMetaDescription(articleTitle);
      const imageDescription = await generateImageDescription(articleTitle);
      if (metaDescription) {
        const seoKeywords = await generateSEOKeywords(articleTitle);
        const imageResult = await fal.subscribe("fal-ai/flux-pro", {
          input: { 
              prompt: imageDescription,
              image_size: 'landscape_16_9'                
          },
          logs: true,
          onQueueUpdate: (update) => {
              if (update.status === "IN_PROGRESS") {
                  update.logs.map((log) => log.message).forEach(console.log);
              }
          },
      });
      const imageUrl = imageResult.images[0].url;
        console.log("fal: ", imageUrl);
        // const image = await openai.images.generate({ model: "dall-e-3", prompt: `generate a featured image for an article with title: ${rewrittenTitle}` });
        // const imageUrl = image.data[0].url;
        if (imageUrl) {
          console.log('Rewritten Title:', rewrittenTitle);
          createArticleOnShopify(rewrittenTitle, rewrittenContent, metaDescription, imageUrl, seoKeywords);
        }
      } else {
        console.log('Failed to generate meta description.');
        await returnFirstTitle('./articles_topics.txt', articleTitle);
      }
    } else {
      console.log('Failed to rewrite the title.');
      await returnFirstTitle('./articles_topics.txt', articleTitle);
    }
  } else {
    console.log('Failed to rewrite article content.');
    await returnFirstTitle('./articles_topics.txt', articleTitle);
  }
}

async function getAndRemoveFirstTitle(filePath) {
    try {
        // Read the content of the file
        let fileContent = await fs.promises.readFile(filePath, 'utf8');

        // Split the content by new lines
        let lines = fileContent.split('\n');

        // Check if the file is not empty
        if (lines.length === 0) {
            throw new Error('The file is empty');
        }

        // Save the first title to a variable
        let firstTitle = lines[0];

        // Remove the first title from the array
        lines.shift();

        // Join the remaining lines back into a string
        let updatedContent = lines.join('\n');

        // Write the updated content back to the file
        await fs.promises.writeFile(filePath, updatedContent, 'utf8');

        // Return the first title
        return firstTitle;
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
}

async function returnFirstTitle(filePath, title) {
  try {
      // Read the current content of the file
      let fileContent = await fs.promises.readFile(filePath, 'utf8');

      // Prepend the title to the content
      let updatedContent = title + '\n' + fileContent;

      // Write the updated content back to the file
      await fs.promises.writeFile(filePath, updatedContent, 'utf8');

      console.log('the title returned: ', title);
  } catch (error) {
      console.error('An error occurred:', error);
      throw error;
  }
}

// Function to perform the scheduled task
async function performScheduledTask() {
  console.log('Running the task');
  const directoryPath = './articles_topics.txt'; // Directory containing the articles
  const articleTitle = await getAndRemoveFirstTitle(directoryPath);
  console.log(articleTitle);
  console.log('###');

  if (articleTitle && articleTitle.trim().length > 0) {
    console.log('title exist');
    postArticle(articleTitle);
  } else {
    console.log('generating title...');
    let generatedTitle = await generateArticleTitle();
    postArticle(generatedTitle);
  }
}

// Calculate the interval in hours and round it
let intervalHours = Math.round(24 / articlesPerDay);
console.log(intervalHours);

// Construct the cron expression
let cronExpression = `0 0 */${intervalHours} * * *`;

// let cronExpression = `*/5 * * * *`;

// Schedule the task
cron.schedule(cronExpression, () => {
  performScheduledTask();
});

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Server is running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  performScheduledTask();
});
