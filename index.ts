import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req) => {
  const edgeExecId = Math.random().toString(36).substring(7);
  const traceId = req.headers.get("X-Webhook-Trace-Id") || "NONE";
  console.log(`[EDGE ENTRY] ExecId: ${edgeExecId} | TraceId: ${traceId} | User-Agent: ${req.headers.get("user-agent")}`);

  try {
    const { clinic_id, patient_phone, message_text, meta_message_id } = await req.json();
    console.log(`[EDGE PARSED] clinic_id: ${clinic_id}, text: ${message_text}`);

    // Absolute Database-Backed Firewall Idempotency Lock
    if (!meta_message_id) {
        console.warn(`[SUPABASE FIREWALL] Blocked execution entirely because meta_message_id is missing. This happens when an outdated Vercel production server triggers the webhook.`);
        return new Response(JSON.stringify({ success: true, bypassed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const { error: lockErr } = await supabase.from('processed_webhooks').insert({ id: meta_message_id });
    if (lockErr) {
       console.warn(`[SUPABASE FIREWALL] Blocked duplicate execution for message: ${meta_message_id} (Trace: ${traceId})`);
       return new Response(JSON.stringify({ success: true, bypassed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const [{ data: clinic }, { data: content }] = await Promise.all([
      supabase.from("clinics").select("*").eq("id", clinic_id).single(),
      supabase.from("clinic_content").select("*").eq("clinic_id", clinic_id).single(),
    ]);

    if (!clinic || !content) return new Response("Clinic missing", { status: 400 });

    // Bot Active Toggle Logic
    const botActive = clinic.bot_active !== false;

    // 2. Fetch or create patient
    let { data: patient } = await supabase
      .from("patients")
      .select("*")
      .match({ clinic_id, phone: patient_phone })
      .single();

    if (!patient) {
      const { data: newPatient } = await supabase
        .from("patients")
        .insert({ clinic_id, phone: patient_phone })
        .select()
        .single();
      patient = newPatient;
    }

    // 3. Fetch conversation history (last 12 messages)
    let { data: conversation } = await supabase
      .from("conversations")
      .select("*")
      .match({ clinic_id, patient_phone })
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({ clinic_id, patient_phone, messages: [] })
        .select()
        .single();
      conversation = newConv;
    }

    const cairoNow = new Date().toLocaleString("en-CA", { timeZone: "Africa/Cairo", hour12: false }).replace(",", "");
    const cairoDate = cairoNow.split(" ")[0]; // "YYYY-MM-DD"
    const cairoTime = cairoNow.split(" ")[1].slice(0, 5); // "HH:MM"

    const messages = conversation.messages || [];
    const history = messages.slice(-12);

    // Extract any confirmed booking fields from older history that was cut off
    const fullHistory = messages;
    const confirmedFields: any = {};
    for (const msg of fullHistory) {
      if (msg.role === "assistant" && msg.content) {
        const m = msg.content.match(/<<<ACTION>>>([\s\S]*?)<<<END>>>/);
        if (m) {
          try {
            const p = JSON.parse(m[1].trim());
            if (p.action === "book") {
              if (p.patient_name) confirmedFields.patient_name = p.patient_name;
              if (p.date) confirmedFields.date = p.date;
              if (p.time) confirmedFields.time = p.time;
            }
          } catch { }
        }
      }
    }

    const fieldSummary = Object.keys(confirmedFields).length > 0
      ? `\n[ملاحظة للبوت: البيانات المتأكدة من المحادثة السابقة: ${JSON.stringify(confirmedFields)}]`
      : "";

    history.push({ id: crypto.randomUUID(), role: "user", content: message_text + fieldSummary, created_at: new Date().toISOString() });

    if (!botActive) {
      // Just record the incoming message to conversation history, but skip the AI
      await supabase.from("conversations").update({ messages: history, last_message_at: new Date().toISOString() }).eq("id", conversation.id);
      return new Response(JSON.stringify({ success: true, ai_skipped: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Fetch booked slots
    const todayAndFuture = cairoDate;
    const { data: bookedSlots } = await supabase
      .from("appointments")
      .select("appointment_date, appointment_time, patient_name")
      .eq("clinic_id", clinic_id)
      .eq("status", "confirmed")
      .gte("appointment_date", todayAndFuture);

    const bookedText = bookedSlots && bookedSlots.length > 0
      ? bookedSlots.map(b => {
        let timeMsg = b.appointment_time;
        if (timeMsg) {
          const parts = timeMsg.split(":");
          if (parts.length >= 2) {
            let h = parseInt(parts[0], 10);
            const m = parts[1];
            const ampm = h >= 12 ? "م" : "ص";
            h = h % 12 || 12;
            timeMsg = `${h}:${m} ${ampm}`;
          }
        }
        return `- ${b.appointment_date} الساعة ${timeMsg} (محجوز)`;
      }).join("\n")
      : "لا توجد حجوزات حالية";

    const systemPrompt = `[الأولويات: 1-الشخصية 2-التعليمات الخاصة بالعيادة 3-قواعد الحجز 4-معلومات العيادة 5-الحالات الخاصة 6-JSON]

أنت ${content.bot_persona || "مساعد استقبال"} في ${clinic.clinic_name}.
بتتكلم بالعامية المصرية بشكل طبيعي وودي زي موظف استقبال حقيقي مش بوت.
ممنوع تقول إنك بوت أو ذكاء اصطناعي.
ممنوع علامات ترقيم غير (؟) في نهاية الأسئلة بس.
استخدم نظام 12 ساعة دايماً (مثلاً 4:30 العصر) ممنوع 24 ساعة أو ثواني.
النهارده هو ${cairoDate}.

=== تعليمات خاصة بالعيادة — اتبعها دايماً ===
${content.custom_instructions || "لا يوجد"}

=== معلومات العيادة ===
${content.clinic_info || ""}

=== أوقات العمل ===
${content.availability_text || ""}

=== المريض ===
ده مريض جديد أو حالي. اتعامل معاه باهتمام.

=== المواعيد المحجوزة ===
${bookedText}
ممنوع تأكد أي وقت موجود في القائمة دي. لو محجوز اقترح أقرب وقتين متاحين.

=== قواعد الحجز ===
البيانات المطلوبة: ${content.booking_fields || ""}
مدة الكشف: ${content.appointment_duration_minutes || 30} دقيقة
${content.cancellation_allowed
        ? "الإلغاء متاح عبر واتساب، لو طلب يلغي ساعده وأكد الإلغاء."
        : "الإلغاء مش متاح عبر واتساب، قوله يتصل بالعيادة."}

خطوات الحجز الإجبارية بالترتيب:
1. اجمع البيانات المطلوبة كلها (الاسم والوقت وأي بيانات تانية)
2. ابعت ملخص: الاسم والتاريخ بالشكل (${cairoDate.slice(0, 4)} / MM / DD) والوقت — وسأله "تأكد الحجز؟" — استخدم action: null وانتظر
3. لو المريض أكد (أيوه أو تمام أو ما شابه) — استخدم action: book
4. بعد التسجيل أكدله: الاسم والتاريخ والوقت بس لا تزيد

ممنوع تستخدم action: book قبل ما المريض يأكد صراحةً في رسالة منفصلة.
ممنوع تحجز وقتين لنفس الوقت.

=== حالات خاصة ===
- وقت مبهم (بعد الضهر / الصبح): اسأل عن الساعة بالظبط أولاً
- سؤال طبي أو تحاليل أو دواء: "الدكتور هو اللي يقدر يجاوبك على ده"
- طلب خارج نطاق العيادة: "للأسف مش قادر أساعدك في ده"
- رسالة مش واضحة أو غير عربي: اطلب منه يوضح بالعربي
- معلومة مش موجودة عندك: متقترحش إنك تساعده فيها
- رد على اللي سُئلت عنه بس متزودش

=== مهم جدًا ===
رد على قد السؤال متتابعش بسؤال تاني.
في آخر كل رد حط JSON على سطر منفصل (المريض مش هيشوفه):
<<<ACTION>>>{"action": null}<<<END>>>
لو في حجز مؤكد من المريض:
<<<ACTION>>>{"action": "book", "date": "YYYY-MM-DD", "time": "hh:mm AM/PM", "patient_name": "الاسم"}<<<END>>>
لو في إلغاء:
<<<ACTION>>>{"action": "cancel"}<<<END>>>
لازم الـ JSON محاط بـ <<<ACTION>>> و <<<END>>> بالضبط. متحطش أي حاجة بعده.`;
    // 5. Call OpenRouter API
    const claudeRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ANTHROPIC_API_KEY}`
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-lite-preview",
        max_tokens: 600,
        messages: [
          { role: "system", content: systemPrompt },
          ...history
        ]
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

    let rawReply = claudeData.choices?.[0]?.message?.content;
    if (typeof rawReply !== 'string') {
      console.error("AI model returned invalid or null content:", JSON.stringify(claudeData));
      rawReply = "عفواً، المساعد غير قادر على الرد حالياً. يرجى المحاولة بعد قليل.";
    }

    let replyText = rawReply;
    let action = null;

    // 6. Parse JSON action
    try {
      const sentinelMatch = rawReply.match(/<<<ACTION>>>([\s\S]*?)<<<END>>>/);
      if (sentinelMatch) {
        let jsonString = sentinelMatch[1].trim();
        // Remove markdown backticks if the AI added them
        jsonString = jsonString.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();

        const parsed = JSON.parse(jsonString);
        if (parsed.action) {
          action = parsed;
        }
        replyText = rawReply.slice(0, rawReply.indexOf("<<<ACTION>>>")).trim();
      } else {
        // Fallback: observe if it just outputted ```json block at the end
        const fallbackMatch = rawReply.match(/```json\s*(\{[\s\S]*?\})\s*```/);
        if (fallbackMatch) {
          const parsed = JSON.parse(fallbackMatch[1].trim());
          if (parsed.action) {
            action = parsed;
          }
          replyText = rawReply.slice(0, rawReply.indexOf("```json")).trim();
        }
      }
    } catch (e) {
      console.warn("⚠️ Failed to parse action sentinel from AI reply. Error:", e, "Raw Reply:", rawReply);
    }

    history.push({ id: crypto.randomUUID(), role: "assistant", content: rawReply, created_at: new Date().toISOString() });

    // 7. Execute Actions (book, cancel)
    if (action?.action === "book") {
      // If the patient is editing or making a new booking, cancel any existing active ones first
      const { data: existingAppts } = await supabase.from("appointments").select("id").match({ clinic_id, patient_phone, status: "confirmed" });
      if (existingAppts && existingAppts.length > 0) {
        const idsToCancel = existingAppts.map((a: any) => a.id);
        await supabase.from("appointments").update({ status: "cancelled" }).in("id", idsToCancel);
      }

      await supabase.from("appointments").insert({
        clinic_id,
        patient_phone,
        patient_name: action.patient_name || patient.name,
        appointment_date: action.date,
        appointment_time: action.time,
        status: "confirmed"
      });
      // updating patient name
      await supabase.from("patients").update({
        name: action.patient_name || patient.name,
        visit_count: patient.visit_count + 1,
        last_visit: new Date().toISOString()
      }).eq("id", patient.id);

      await supabase.from("analytics_events").insert({ clinic_id, event_type: "appointment_booked" });
    } else if (action?.action === "cancel") {
      // logic to cancel (soft delete / update status)
      const { data: toCancelList } = await supabase.from("appointments").select("id").match({ clinic_id, patient_phone, status: "confirmed" });
      if (toCancelList && toCancelList.length > 0) {
        const ids = toCancelList.map((t: any) => t.id);
        await supabase.from("appointments").update({ status: "cancelled" }).in("id", ids);
        await supabase.from("analytics_events").insert({ clinic_id, event_type: "appointment_cancelled" });
      }
    }

    // always log response
    await supabase.from("analytics_events").insert({ clinic_id, event_type: "bot_message_sent" });
    if (history.length === 2) await supabase.from("analytics_events").insert({ clinic_id, event_type: "conversation_started" });

    // 8. Update conversation history
    await supabase.from("conversations").update({ messages: history, last_message_at: new Date().toISOString() }).eq("id", conversation.id);

    // 9. Send WhatsApp Message via Meta Graph API
    if (clinic.whatsapp_phone_id && clinic.whatsapp_access_token) {
      await fetch(`https://graph.facebook.com/v18.0/${clinic.whatsapp_phone_id}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${clinic.whatsapp_access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: patient_phone,
          type: "text",
          text: { body: replyText }
        })
      });
    }

    // 10. Trial usage increment logic
    if (clinic.subscription_status === 'trial') {
      await supabase.from("clinics").update({ trial_conversations_used: clinic.trial_conversations_used + 1 }).eq("id", clinic_id);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error("Unhandled process edge function error", err);
    return new Response("Internal Error", { status: 500 });
  }
});