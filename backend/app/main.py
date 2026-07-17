import sys
import asyncio
import threading
import json
import logging
from datetime import datetime
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
import random
from playwright.async_api import async_playwright

from backend.app.config import settings
from backend.app.database import (
    accounts_col, leads_col, settings_col, logs_col, seed_initial_settings, get_db_status
)
from backend.app.models import LeadCreate, AccountCreate, SettingsUpdate, GenerateMessageRequest, LeadStatusUpdate
from backend.app.services.ai_service import ai_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

app = FastAPI(title="Instagram Outreach Automation Hub", version="1.0.0")

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Seed initial settings and mock data on startup
seed_initial_settings()

# State variable for the background automation queue
campaign_running = False
log_queue = asyncio.Queue()


def normalize_instagram_username(value: str) -> str:
    """Normalize usernames so @name / @@name are stored consistently as name."""
    return value.strip().lstrip("@").strip().lower()


def extract_inserted_id(result):
    """Extract inserted id from pymongo result or fallback insert return value."""
    if hasattr(result, "inserted_id"):
        return str(result.inserted_id)
    if isinstance(result, dict) and result.get("_id") is not None:
        return str(result.get("_id"))
    return None

def log_event(message: str, level: str = "INFO"):
    """Saves a log message to the database and queue for SSE stream"""
    timestamp = datetime.now().isoformat()
    log_doc = {"timestamp": timestamp, "level": level, "message": message}
    try:
        logs_col.insert_one(log_doc)
    except Exception:
        pass
    
    # Broadcast to dashboard SSE
    asyncio.create_task(log_queue.put(log_doc))


# ═══ WINDOWS SUBPROCESS THREAD ISOLATION ENGINE ═══
# ═══ WINDOWS SUBPROCESS THREAD ISOLATION ENGINE ═══

def run_proactor_loop(async_func, *args, **kwargs):
    """
    Helper function to instantiate and run a coroutine inside an isolated Windows 
    Proactor event loop within a separate, dedicated background OS thread.
    This completely bypasses Uvicorn's SelectorEventLoop restrictions.
    """
    result = None
    exception = None

    def worker():
        nonlocal result, exception
        try:
            if sys.platform == "win32":
                # Set loop policy for this thread
                asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                coro = async_func(*args, **kwargs)
                result = loop.run_until_complete(coro)
            finally:
                loop.close()
        except Exception as e:
            exception = e

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    if exception:
        raise exception
    return result

    def worker():
        nonlocal result, exception
        if sys.platform == "win32":
            loop = asyncio.WindowsProactorEventLoop()
        else:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            # Safely instantiate and run the coroutine in the background thread
            coro = async_func(*args, **kwargs)
            result = loop.run_until_complete(coro)
        except Exception as e:
            exception = e
        finally:
            loop.close()

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    if exception:
        raise exception
    return result


# STATE_FILE = "storage_state.json"
# Create an absolute path to storage_state.json in your root project folder
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_FILE = os.path.join(BASE_DIR, "storage_state.json")

async def _playwright_send_flow(account, lead, dm_text):
    """Isolated Playwright execution context with explicit absolute session loading and navigation rescue"""
    print(">>> RUNNING THE NEW AUTO-SEND FLOW (V2) <<<") # <--- ADD THIS LINE
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        
        context_args = {
            "viewport": {"width": 1280, "height": 720},
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        
        # Absolute path session check
        if os.path.exists(STATE_FILE):
            log_event("Found active session state. Restoring authenticated cookies...", "INFO")
            context = await browser.new_context(storage_state=STATE_FILE, **context_args)
            page = await context.new_page()
        else:
            log_event("No session state found. Initiating first-time login sequence...", "WARNING")
            context = await browser.new_context(**context_args)
            page = await context.new_page()
            page.set_default_timeout(15000)
            
            await page.goto("https://www.instagram.com/accounts/login/")
            await page.wait_for_timeout(4000)
            
            if "login" in page.url:
                try:
                    await page.wait_for_selector('input[name="username"]', timeout=8000)
                    await page.fill('input[name="username"]', account["username"])
                    await page.wait_for_timeout(random.randint(1000, 2000))
                    await page.fill('input[name="password"]', account["password"])
                    await page.wait_for_timeout(random.randint(1000, 2000))
                    await page.click('button[type="submit"]')
                    
                    log_event("Credentials entered automatically. If prompted, click 'Save Info' or enter security codes now...", "WARNING")
                except Exception:
                    log_event("Login fields not found or bypassed. Please log in manually if needed...", "INFO")
            
            # Wait up to 60 seconds for you to log in/redirect
            for attempt in range(12):
                await page.wait_for_timeout(5000)
                if "login" not in page.url:
                    break
            
            try:
                # Save session state so we don't need credentials next time
                await context.storage_state(path=STATE_FILE)
                log_event("Session authenticated and saved successfully.", "SUCCESS")
            except Exception as e:
                log_event(f"Could not save session state: {str(e)}", "WARNING")

        # --- GUARANTEED LEAD PROFILE NAVIGATION ---
        log_event(f"Opening lead profile: @{lead['username']}...", "INFO")
        try:
            # Navigate to target profile and ignore heavy home feed loads
            await page.goto(f"https://www.instagram.com/{lead['username']}/", wait_until="domcontentloaded", timeout=45000)
        except Exception:
            log_event("Profile page took too long to fully load. Proceeding with DOM elements...", "WARNING")
            
        await page.wait_for_timeout(random.randint(5000, 8000))
        
        # Click the "Message" button on the profile page
        message_btn = page.get_by_role("button", name="Message").first
        if await message_btn.is_visible():
            await message_btn.click()
        else:
            log_event("Message button locator missing on profile. Navigating directly to thread URL...", "WARNING")
            try:
                await page.goto(f"https://www.instagram.com/direct/t/{lead['username']}/", wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass
            
        await page.wait_for_timeout(random.randint(6000, 9000))

        # Locate the chat input box and wait for it to be ready
        log_event("Locating direct message input box...", "INFO")
        dm_input = page.locator("div[role='textbox']").first
        await dm_input.wait_for(state="visible", timeout=20000)
        await dm_input.focus()
        
        await page.wait_for_timeout(random.randint(1500, 3000))

        log_event(f"Auto-pasting outreach proposal to @{lead['username']}...", "INFO")
        
        # Inject text directly using keyboard event simulator
        await page.keyboard.insert_text(dm_text)
        
        await page.wait_for_timeout(random.randint(2000, 4500))
        await page.keyboard.press("Enter")
        log_event(f"Message sent successfully to @{lead['username']}!", "SUCCESS")
        
        await page.wait_for_timeout(8000)
        
        # Update our session cookies with the latest state
        await context.storage_state(path=STATE_FILE)
        
        await context.close()
        await browser.close()

# Background Queue Task
async def run_automation_loop():
    global campaign_running
    log_event("Starting backend lead processing loop...", "INFO")
    
    while campaign_running:
        try:
            accounts = list(accounts_col.find({"status": "Active"}))
            if not accounts:
                log_event("No active accounts available! Halting outreach loop.", "WARNING")
                campaign_running = False
                break
                
            lead = leads_col.find_one({"status": "Pending"})
            if not lead:
                log_event("No pending leads remaining in the database.", "INFO")
                campaign_running = False
                break
            
            account = accounts[0]
            leads_col.update_one(
                {"_id": lead["_id"]},
                {"$set": {"status": "Processing", "last_action": datetime.now().isoformat()}}
            )
            log_event(
                f"[{account['username']}] Processing lead @{lead['username']} (DB mode: {get_db_status().get('mode', 'unknown')}).",
                "INFO"
            )

            if not settings.LIVE_EXECUTION_ENABLED:
                leads_col.update_one(
                    {"_id": lead["_id"]},
                    {"$set": {"status": "ReadyForExecution", "last_action": datetime.now().isoformat()}}
                )
                log_event(
                    f"[{account['username']}] Lead @{lead['username']} prepared only. LIVE_EXECUTION_ENABLED=false, so no Instagram action was performed.",
                    "WARNING"
                )
                await asyncio.sleep(1)
                continue

            leads_col.update_one(
                {"_id": lead["_id"]},
                {"$set": {"status": "DMed", "last_action": datetime.now().isoformat()}}
            )
            log_event(f"Real outreach execution completed for lead @{lead['username']}.", "SUCCESS")
            
            # Update account analytics
            accounts_col.update_one(
                {"_id": account["_id"]},
                {"$inc": {"daily_actions.dm": 1, "daily_actions.follow": 1, "daily_actions.like": 1}}
            )
            
            cooldown = settings.MIN_DELAY_SECONDS
            log_event(f"Cooldown for {cooldown} seconds before next lead...", "INFO")
            
            for _ in range(cooldown):
                if not campaign_running:
                    break
                await asyncio.sleep(1)
                
        except Exception as e:
            log_event(f"Automation execution error: {str(e)}", "ERROR")
            if lead:
                leads_col.update_one({"_id": lead["_id"]}, {"$set": {"status": "Failed"}})
            await asyncio.sleep(10)

# API Endpoints

@app.get("/api/dashboard/stats")
async def get_dashboard_stats():
    total_leads = leads_col.count_documents({})
    pending_leads = leads_col.count_documents({"status": "Pending"})
    dmed_leads = leads_col.count_documents({"status": "DMed"})
    replied_leads = leads_col.count_documents({"status": "Replied"})
    failed_leads = leads_col.count_documents({"status": "Failed"})
    active_accounts = accounts_col.count_documents({"status": "Active"})
    
    return {
        "total_leads": total_leads,
        "pending_leads": pending_leads,
        "dmed_leads": dmed_leads,
        "replied_leads": replied_leads,
        "failed_leads": failed_leads,
        "active_accounts": active_accounts,
        "campaign_running": campaign_running,
        "db_mode": get_db_status().get("mode", "unknown")
    }


@app.get("/api/health/db")
async def db_health():
    return get_db_status()

@app.get("/api/accounts")
async def get_accounts():
    accounts = list(accounts_col.find({}, {"password": 0}))
    for acc in accounts:
        if "_id" in acc:
            acc["_id"] = str(acc["_id"])
    return accounts

@app.post("/api/accounts")
async def add_account(acc: AccountCreate):
    try:
        username = normalize_instagram_username(acc.username)
        db_mode = get_db_status().get("mode", "unknown")
        new_acc = {
            "username": username,
            "status": "Active",
            "password": acc.password,
            "proxy": acc.proxy,
            "daily_actions": {"dm": 0, "follow": 0, "like": 0},
            "last_active": None
        }
        result = accounts_col.insert_one(new_acc)
        inserted_id = extract_inserted_id(result)
        log_event(
            f"Account saved to DB ({db_mode}): @{username} (id={inserted_id or 'n/a'}).",
            "SUCCESS"
        )
        return {
            "status": "success",
            "message": "Account added.",
            "username": username,
            "id": inserted_id,
            "db_mode": db_mode,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Account save failed: {str(e)}")

@app.get("/api/leads")
async def get_leads():
    leads = list(leads_col.find())
    for lead in leads:
        if "_id" in lead:
            lead["_id"] = str(lead["_id"])
    return leads

@app.post("/api/leads")
async def add_lead(lead: LeadCreate):
    try:
        username = normalize_instagram_username(lead.username)
        db_mode = get_db_status().get("mode", "unknown")
        result = leads_col.insert_one({
            "username": username,
            "niche": lead.niche,
            "status": lead.status,
            "last_action": None
        })
        inserted_id = extract_inserted_id(result)
        log_event(
            f"Lead saved to DB ({db_mode}): @{username} (id={inserted_id or 'n/a'}).",
            "INFO"
        )
        return {
            "status": "success",
            "username": username,
            "id": inserted_id,
            "db_mode": db_mode,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Lead save failed: {str(e)}")


@app.post("/api/leads/status")
async def update_lead_status(payload: LeadStatusUpdate):
    try:
        from bson import ObjectId
        try:
            query_id = ObjectId(payload.lead_id)
        except Exception:
            query_id = payload.lead_id
            
        leads_col.update_one(
            {"_id": query_id},
            {"$set": {"status": payload.status, "last_action": datetime.now().isoformat()}}
        )
        log_event(f"Lead status manually updated to '{payload.status}'.", "INFO")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/settings")
async def get_settings():
    db_settings = settings_col.find_one({})
    if db_settings:
        if "_id" in db_settings:
            db_settings["_id"] = str(db_settings["_id"])
        return db_settings
    return {}

@app.post("/api/settings")
async def update_settings(payload: SettingsUpdate):
    settings_col.update_one(
        {},
        {"$set": {
            "campaign_name": payload.campaign_name,
            "dm_template": payload.dm_template,
            "comment_template": payload.comment_template,
            "safety_warmup_mode": payload.safety_warmup_mode,
            "max_leads_per_day": payload.max_leads_per_day
        }},
        upsert=True
    )
    log_event("Global campaign parameter profiles successfully reconfigured.", "INFO")
    return {"status": "success"}

@app.post("/api/ai/preview")
async def preview_ai_msg(payload: GenerateMessageRequest):
    dm = ai_service.generate_b2b_dm(payload.username, payload.niche, payload.custom_instructions)
    comment = ai_service.generate_comment(payload.username, payload.niche)
    return {"dm": dm, "comment": comment}

@app.post("/api/campaign/toggle")
async def toggle_campaign(background_tasks: BackgroundTasks):
    global campaign_running
    campaign_running = not campaign_running
    if campaign_running:
        background_tasks.add_task(run_automation_loop)
        log_event("Campaign dispatcher launched.", "INFO")
    else:
        log_event("Campaign dispatcher paused.", "WARNING")
    return {"running": campaign_running}

@app.get("/api/logs/stream")
async def logs_stream():
    async def event_generator():
        past_logs = list(logs_col.find().sort("timestamp", -1).limit(20))
        for log in reversed(past_logs):
            yield f"data: {json.dumps({'timestamp': log['timestamp'], 'level': log['level'], 'message': log['message']})}\n\n"
            
        while True:
            log_item = await log_queue.get()
            yield f"data: {json.dumps(log_item)}\n\n"
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/leads/send-auto")
async def auto_send_outreach(payload: LeadStatusUpdate):
    """Launches Playwright securely using isolated background worker thread execution"""
    try:
        from bson import ObjectId
        # 1. Fetch the target lead
        try:
            query_id = ObjectId(payload.lead_id)
        except Exception:
            query_id = payload.lead_id
            
        lead = leads_col.find_one({"_id": query_id})
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
            
        # 2. Fetch active sender account details
        account = accounts_col.find_one({"status": "Active"})
        if not account:
            raise HTTPException(status_code=400, detail="No active sender profile found")
            
        password = account.get("password")
        if not password:
            raise HTTPException(status_code=400, detail="Password is required for first-time login verification")

        log_event(f"Initializing browser engine for @{account['username']}...", "INFO")
        
        # 3. Generate the custom AI message
        dm_text = ai_service.generate_b2b_dm(lead["username"], lead["niche"])
        
        # 4. Offload task to our isolated background Proactor loop to prevent NotImplementedError
        await asyncio.to_thread(
            run_proactor_loop, 
            _playwright_send_flow, 
            account, 
            lead, 
            dm_text
        )
            
        # 5. Update lead status in DB
        leads_col.update_one(
            {"_id": query_id},
            {"$set": {"status": "DMed", "last_action": datetime.now().isoformat()}}
        )
        
        log_event(f"Successfully auto-sent DM to @{lead['username']}.", "SUCCESS")
        return {"status": "success", "message": f"Message sent to @{lead['username']}!"}
        
    except Exception as e:
        log_event(f"Execution failed safely: {str(e)}", "ERROR")
        raise HTTPException(status_code=500, detail=f"Failed to execute securely: {str(e)}")

# Mount Dashboard SPA
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")