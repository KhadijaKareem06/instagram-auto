import os
import logging
from groq import Groq
from backend.app.config import settings


logger = logging.getLogger("ai_service")

class AIService:
    def __init__(self):
        # Retrieve Groq client dynamically using the loaded API key
        self.api_key = settings.GROQ_API_KEY or os.getenv("GROQ_API_KEY", "")
        self.client = None
        if self.api_key:
            try:
                self.client = Groq(api_key=self.api_key)
            except Exception as e:
                logger.error(f"Failed to initialize Groq client: {e}")

    def generate_b2b_dm(self, username: str, niche: str, custom_instructions: str = None) -> str:
        """
        Generates a premium, highly personalized B2B outreach message using the configured Groq model.
        Optimized for martial arts and fashion wear manufacturing outreach.
        """
        if not self.client:
            # Fallback template if Groq API is not provided or fails to initialize
            return (
                f"Hey @{username}! Absolute fan of your page. We are direct custom apparel "
                f"manufacturers specializing in high-performance clothing and gear for the {niche} industry. "
                "We work with brands around the globe providing direct-factory manufacturing, outstanding material quality, "
                "and very competitive pricing. Would you be open to a quick chat or seeing our catalog?"
            )

        try:
            system_prompt = (
                "You are an expert B2B Sales Representative specializing in international textile and apparel manufacturing. "
                "Your objective is to generate highly engaging, professional, and friendly outreach messages to potential B2B wholesale buyers, "
                "brands, gym owners, or retail stores. The messaging must be natural, customized, short, and highly clickable. "
                "Avoid corporate jargon and salesy buzzwords. Sound authentic and helpful."
            )

            prompt = (
                f"Target Instagram Lead: @{username}\n"
                f"Business Niche: {niche} (specifically fashion apparel or martial arts uniforms/gear)\n"
                f"Details of Offer: We are custom manufacturers offering direct-to-factory production, robust quality checks, low MOQ, and custom branding.\n"
                f"Custom Instructions: {custom_instructions if custom_instructions else 'Keep it under 3-4 sentences. Include a soft call to action.'}\n\n"
                "Generate ONLY the final outreach message. Do not include placeholders, intro remarks, or outro explanations."
            )

            completion = self.client.chat.completions.create(
                model=settings.GROQ_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.7,
                max_tokens=250
            )
            return completion.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"Error during Groq API call: {e}")
            return (
                f"Hello @{username}, we specialize in premium wholesale manufacturing for {niche}. "
                "Would love to connect and share some of our bespoke designs and catalogs with you!"
            )

    def generate_comment(self, username: str, niche: str) -> str:
        """
        Generates a context-aware Instagram comment that looks genuine and authentic to avoid bot flags.
        """
        if not self.client:
            return "This looks incredibly high-quality! Excellent craftsmanship and attention to detail. 🚀💪"

        try:
            prompt = (
                f"Create a short, authentic 1-sentence comment on a post for an Instagram page about {niche}. "
                "Make it sound highly supportive, professional, and written by a real clothing manufacturer admire team. "
                "Add 1 relevant emoji. Do not use generic phrases like 'Great post!' or 'Check us out!'. "
                "Just give the comment."
            )
            
            completion = self.client.chat.completions.create(
                model=settings.GROQ_MODEL,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                temperature=0.8,
                max_tokens=50
            )
            return completion.choices[0].message.content.strip().replace('"', '')
        except Exception:
            return "Fantastic designs! Love the premium quality finish on this. Keep pushing limits! 🔥🙌"

ai_service = AIService()
