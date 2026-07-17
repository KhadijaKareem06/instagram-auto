import os
import json
import logging
from pymongo import MongoClient, ASCENDING, DESCENDING
from backend.app.config import settings

logger = logging.getLogger("database")

db = None
client = None
DB_MODE = "unknown"
DB_ERROR = None

FALLBACK_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fallback_db.json")


def _safe_uri(uri: str) -> str:
    """Redact credentials in connection URI for safe logging."""
    if not uri:
        return ""
    if "@" in uri and "://" in uri:
        scheme, rest = uri.split("://", 1)
        auth_host = rest.split("@", 1)
        if len(auth_host) == 2:
            return f"{scheme}://***:***@{auth_host[1]}"
    return uri


def _load_fallback_state():
    if os.path.exists(FALLBACK_DB_PATH):
        try:
            with open(FALLBACK_DB_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
                if isinstance(data, dict):
                    return {
                        "accounts": list(data.get("accounts", [])),
                        "leads": list(data.get("leads", [])),
                        "campaign_settings": list(data.get("campaign_settings", [])),
                        "logs": list(data.get("logs", [])),
                    }
        except Exception as exc:
            logger.warning(f"Could not read fallback DB file: {exc}")

    return {
        "accounts": [],
        "leads": [],
        "campaign_settings": [],
        "logs": [],
    }


def _persist_fallback_state(state):
    try:
        with open(FALLBACK_DB_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=True, indent=2)
    except Exception as exc:
        logger.warning(f"Could not persist fallback DB file: {exc}")


def _setup_real_collections(database):
    accounts = database["accounts"]
    leads = database["leads"]
    campaign_settings = database["campaign_settings"]
    logs = database["logs"]

    # Build indexes for high performance
    leads.create_index([("username", ASCENDING)], unique=True)
    leads.create_index([("status", ASCENDING)])
    accounts.create_index([("username", ASCENDING)], unique=True)
    logs.create_index([("timestamp", DESCENDING)])
    return accounts, leads, campaign_settings, logs


def _connect_mongodb():
    uris_to_try = []
    if settings.MONGODB_URI:
        uris_to_try.append(settings.MONGODB_URI)
    if settings.MONGODB_DIRECT_URI and settings.MONGODB_DIRECT_URI not in uris_to_try:
        uris_to_try.append(settings.MONGODB_DIRECT_URI)

    connection_errors = []
    for uri in uris_to_try:
        try:
            mongo_client = MongoClient(
                uri,
                serverSelectionTimeoutMS=settings.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
                connectTimeoutMS=settings.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
                socketTimeoutMS=settings.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
            )
            mongo_client.admin.command("ping")
            mongo_db = mongo_client[settings.DATABASE_NAME]
            accounts, leads, campaign_settings, logs = _setup_real_collections(mongo_db)
            logger.info(f"Connected to MongoDB using URI: {_safe_uri(uri)}")
            return mongo_client, mongo_db, accounts, leads, campaign_settings, logs, None
        except Exception as exc:
            connection_errors.append(f"{_safe_uri(uri)} -> {exc}")

    return None, None, None, None, None, None, " | ".join(connection_errors)

# Fallback collection for in-memory database when MongoDB is unavailable
class FallbackCursor:
    def __init__(self, data_list):
        self.data = data_list
    def sort(self, *args, **kwargs):
        try:
            key = args[0] if args else "timestamp"
            reverse = kwargs.get("reverse", False) or (len(args) > 1 and args[1] == -1)
            self.data.sort(key=lambda x: x.get(key, ""), reverse=reverse)
        except Exception:
            pass
        return self
    def limit(self, count):
        self.data = self.data[:count]
        return self
    def __iter__(self):
        return iter(self.data)

class FallbackCol:
    def __init__(self, state, key):
        self.state = state
        self.key = key
        self.unique_fields = set()

    @property
    def data(self):
        return self.state[self.key]

    def _save(self):
        _persist_fallback_state(self.state)

    def _matches(self, item, filter_dict):
        if not filter_dict:
            return True
        for k, v in filter_dict.items():
            if item.get(k) != v:
                return False
        return True

    def find(self, filter_dict=None, projection=None, *args, **kwargs):
        rows = [row.copy() for row in self.data if self._matches(row, filter_dict or {})]
        if isinstance(projection, dict):
            excludes = {k for k, v in projection.items() if v == 0}
            if excludes:
                cleaned = []
                for row in rows:
                    for key in excludes:
                        row.pop(key, None)
                    cleaned.append(row)
                rows = cleaned
        return FallbackCursor(rows)

    def find_one(self, filter_dict=None, *args, **kwargs):
        if not self.data:
            return None
        if not filter_dict:
            return self.data[0].copy() if self.data else None
        for item in self.data:
            if self._matches(item, filter_dict):
                return item.copy()
        return None

    def insert_one(self, data, *args, **kwargs):
        import uuid
        if "_id" not in data:
            data["_id"] = str(uuid.uuid4())

        for field in self.unique_fields:
            val = data.get(field)
            if val is None:
                continue
            if any(existing.get(field) == val for existing in self.data):
                raise ValueError(f"Duplicate value for unique field '{field}'")

        self.data.append(data)
        self._save()
        return data

    def insert_many(self, data_list, *args, **kwargs):
        import uuid
        for data in data_list:
            if "_id" not in data:
                data["_id"] = str(uuid.uuid4())
            for field in self.unique_fields:
                val = data.get(field)
                if val and any(existing.get(field) == val for existing in self.data):
                    raise ValueError(f"Duplicate value for unique field '{field}'")

        self.data.extend(data_list)
        self._save()
        return data_list

    def update_one(self, filter_dict, update_dict, *args, **kwargs):
        item = None
        for existing in self.data:
            if self._matches(existing, filter_dict):
                item = existing
                break

        upsert = kwargs.get("upsert", False)
        if not item and upsert:
            item = {**(filter_dict or {})}
            self.data.append(item)

        if item and "$set" in update_dict:
            item.update(update_dict["$set"])
        if item and "$inc" in update_dict:
            for k, v in update_dict["$inc"].items():
                parts = k.split('.')
                if len(parts) > 1:
                    parent = item.get(parts[0], {})
                    if not isinstance(parent, dict):
                        parent = {}
                    parent[parts[1]] = parent.get(parts[1], 0) + v
                    item[parts[0]] = parent
                else:
                    item[k] = item.get(k, 0) + v

        if item:
            self._save()
        return None

    def delete_one(self, filter_dict=None, *args, **kwargs):
        filter_dict = filter_dict or {}
        for idx, item in enumerate(self.data):
            if self._matches(item, filter_dict):
                self.data.pop(idx)
                self._save()
                return None
        return None

    def count_documents(self, filter_dict=None, *args, **kwargs):
        if not filter_dict:
            return len(self.data)
        return len([item for item in self.data if self._matches(item, filter_dict)])

    def create_index(self, fields, **kwargs):
        if kwargs.get("unique") and isinstance(fields, list) and len(fields) == 1:
            field_name = fields[0][0]
            self.unique_fields.add(field_name)
        return None

# Initialize MongoClient with Atlas capability
try:
    client, db, accounts_col, leads_col, settings_col, logs_col, conn_error = _connect_mongodb()
    if not client:
        raise RuntimeError(conn_error or "Unknown MongoDB connection error")

    DB_MODE = "mongodb"
    logger.info("Successfully connected to MongoDB Atlas.")
except Exception as e:
    DB_MODE = "fallback"
    DB_ERROR = str(e)
    logger.error(f"MongoDB unavailable. Using fallback JSON storage: {e}")
    
    fallback_state = _load_fallback_state()
    accounts_col = FallbackCol(fallback_state, "accounts")
    leads_col = FallbackCol(fallback_state, "leads")
    settings_col = FallbackCol(fallback_state, "campaign_settings")
    logs_col = FallbackCol(fallback_state, "logs")
    
    leads_col.create_index([("username", ASCENDING)], unique=True)
    accounts_col.create_index([("username", ASCENDING)], unique=True)

def get_db():
    return db


def get_db_status():
    return {
        "mode": DB_MODE,
        "error": DB_ERROR,
        "direct_uri_configured": bool(settings.MONGODB_DIRECT_URI),
        "server_selection_timeout_ms": settings.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    }

def seed_initial_settings():
    """Seed initial campaign and AI templates if collection is empty"""
    try:
        if settings_col.count_documents({}) == 0:
            default_settings = {
                "campaign_name": "Fashion & Martial Arts B2B Outreach",
                "dm_template": (
                    "Hello {username},\n\n"
                    "We noticed you are doing amazing work in the {niche} sector. "
                    "We are direct manufacturers of premium martial arts uniforms and custom athletic apparel. "
                    "Would you be open to looking at our latest wholesale catalog? We offer direct factory pricing "
                    "with low MOQs.\n\n"
                    "Best regards,\nB2B Apparel Team"
                ),
                "comment_template": "Incredible styling here! The quality of design speaks volumes. Let's connect soon! 🙌🔥",
                "safety_warmup_mode": True,
                "max_leads_per_day": 30
            }
            settings_col.insert_one(default_settings)
            
        # Seed mock accounts if empty for demonstration
        if accounts_col.count_documents({}) == 0:
            mock_accounts = [
                {
                    "username": "b2b_apparel_hub",
                    "status": "Active",
                    "proxy": "http://185.132.53.12:8000",
                    "daily_actions": {"dm": 12, "follow": 8, "like": 19},
                    "last_active": "2026-05-23T00:10:00"
                },
                {
                    "username": "martial_arts_direct",
                    "status": "Cooldown",
                    "proxy": "http://45.89.229.4:3128",
                    "daily_actions": {"dm": 4, "follow": 3, "like": 10},
                    "last_active": "2026-05-22T23:45:00"
                }
            ]
            accounts_col.insert_many(mock_accounts)

        # Seed mock leads if empty
        if leads_col.count_documents({}) == 0:
            mock_leads = [
                {"username": "vanguard_dojo", "niche": "Martial Arts", "status": "Pending", "last_action": None},
                {"username": "apex_fightwear", "niche": "Martial Arts", "status": "Pending", "last_action": None},
                {"username": "urban_chic_boutique", "niche": "Fashion Wear", "status": "DMed", "last_action": "2026-05-22T18:30:00"},
                {"username": "gladiator_gym_gear", "niche": "Martial Arts", "status": "Replied", "last_action": "2026-05-22T19:15:00"},
                {"username": "couture_studios", "niche": "Fashion Wear", "status": "Failed", "last_action": "2026-05-22T14:22:00"}
            ]
            leads_col.insert_many(mock_leads)
    except Exception:
        pass
