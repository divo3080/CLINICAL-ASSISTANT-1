const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint ping giữ server hoạt động
app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is active.');
});

// Prompt hệ thống đóng vai Bác sĩ Nội khoa 20 năm kinh nghiệm
const SYSTEM_PROMPT_HEADER = `
Bạn là một BÁC SĨ NỘI KHOA CAO CẤP CÓ 20 NĂM KINH NGHIỆM LÂM SÀNG TẠI CÁC BỆNH VIỆN TUYẾN TỈNH VÀ TUYẾN TƯƠNG ĐƯƠNG.
Tư duy lâm sàng của bạn kết hợp sắc bén giữa:
1. Thuyết xử lý kép (Dual-Process Theory: System 1 & System 2) và Kịch bản bệnh lý (Illness Scripts).
2. Khung phân loại căn nguyên VINDICATED để loại trừ toàn bộ nguy cơ tử vong/cấp cứu khẩn.
3. Siêu âm tại giường POCUS / BLUE Protocol đối với bệnh nhân suy hô hấp, khó thở, đau ngực.
4. Phác đồ chẩn đoán & điều trị chuẩn của Bộ Y tế Việt Nam (BYT) kết hợp Guidelines quốc tế (ESC, AHA, GINA, GOLD, KDIGO).

Yêu cầu phản hồi:
- Sử dụng ngôn ngữ y khoa chính xác, chuyên nghiệp, súc tích và lập luận chặt chẽ.
- Luôn chỉ ra các căn cứ sinh lý bệnh (Pathophysiology) đằng sau mỗi nhận định.
- Trình bày dạng Markdown với các tiêu đề, bảng biểu và bullet points trực quan.
`;

// Hàm gọi Gemini API hỗ trợ chuyển đổi mô hình dự phòng
async function callGemini(apiKey, promptText, preferredModel = 'gemini-1.5-flash') {
  const cleanKey = apiKey ? apiKey.trim() : (process.env.GEMINI_API_KEY || 'AQ.Ab8RN6K0xi5jK7m65ZD16E6-swsF1kYxKeKM5YYlvcE1DEdFLA');
  if (!cleanKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong .env hoặc giao diện.');
  }

  const modelsToTry = [preferredModel, 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  for (const model of uniqueModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
        })
      });

      if (response.status === 200) {
        const data = await response.json();
        const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) return { text: candidateText, modelUsed: model };
      } else {
        const errText = await response.text();
        lastError = `Model ${model} [Mã ${response.status}]: ${errText}`;
      }
    } catch (err) {
      lastError = `Lỗi kết nối tới ${model}: ${err.message}`;
    }
  }

  throw new Error(`Tất cả mô hình Gemini đều báo lỗi. Chi tiết: ${lastError}`);
}

// Endpoint xử lý phân tích 6 bước lâm sàng
app.post('/api/analyze', async (req, res) => {
  try {
    const { step, caseData, customApiKey, preferredModel } = req.body;
    const apiKey = customApiKey || process.env.GEMINI_API_KEY || 'AQ.Ab8RN6K0xi5jK7m65ZD16E6-swsF1kYxKeKM5YYlvcE1DEdFLA';

    if (!step || !caseData) {
      return res.status(400).json({ error: 'Thiếu tham số "step" hoặc "caseData".' });
    }

    let prompt = `${SYSTEM_PROMPT_HEADER}\n\n=== THÔNG TIN CASE LÂM SÀNG BỆNH NHÂN ===\n`;
    prompt += `📌 Tên / Mã case: ${caseData.title || 'Case Lâm Sàng'}\n`;
    prompt += `📌 BƯỚC 1 - Hành chính & Sinh hiệu: Tuổi ${caseData.step1?.age || 'N/A'}, Giới: ${caseData.step1?.gender || 'N/A'}, Lý do khám: ${caseData.step1?.chief_complaint || 'N/A'}\n`;
    prompt += `📌 Sinh hiệu: ${caseData.step1?.vitals || 'N/A'}\n`;
    prompt += `📌 Bệnh sử: ${caseData.step1?.history || 'N/A'}\n`;
    prompt += `📌 Tiền sử: ${caseData.step1?.pmh || 'N/A'}\n`;
    prompt += `📌 Khám lâm sàng: ${caseData.step1?.physical_exam || 'N/A'}\n`;
    prompt += `📌 CLS hiện có: ${caseData.step1?.current_labs || 'N/A'}\n\n`;

    switch (parseInt(step)) {
      case 2:
        prompt += `=== YÊU CẦU BƯỚC 2: PHÂN TÍCH DANH SÁCH VẤN ĐỀ (PROBLEM LIST) ===\n` +
                  `1. Gom nhóm triệu chứng thành các hội chứng/vấn đề lâm sàng (dùng Semantic Qualifiers).\n` +
                  `2. SẮP XẾP THỨ TỰ ƯU TIÊN MỨC ĐỘ NẶNG (Từ Nguy kịch/Nặng ➔ Nhẹ).\n` +
                  `3. Các câu hỏi/chi tiết CẦN KHAI THÁC THÊM cho từng vấn đề.\n` +
                  `4. Danh mục CẬN LÂM SÀNG BẮT BUỘC cần làm thêm.`;
        break;

      case 3:
        prompt += `📌 Dữ liệu Bước 2: ${caseData.step2?.problem_list || ''}\n\n` +
                  `=== YÊU CẦU BƯỚC 3: CHẨN ĐOÁN SƠ BỘ, PHÂN BIỆT & BIỆN LUẬN ===\n` +
                  `1. CHẨN ĐOÁN SƠ BỘ chính xác nhất.\n` +
                  `2. CÁC CHẨN ĐOÁN PHÂN BIỆT (Khung VINDICATED).\n` +
                  `3. BIỆN LUẬN LÂM SÀNG CHI TIẾT đối chiếu triệu chứng ủng hộ / phản bác.`;
        break;

      case 4:
        prompt += `=== YÊU CẦU BƯỚC 4: YÊU CẦU KHAI THÁC SÂU & CẬN LÂM SÀNG BỔ SUNG ===\n` +
                  `Đề xuất các chi tiết bệnh sử/tiền sử cần hỏi sâu hơn và các cận lâm sàng bổ sung quyết định (POCUS/BLUE protocol, động học men tim, khí máu...).`;
        break;

      case 5:
        prompt += `📌 Thông tin thêm Bước 4: ${caseData.step4?.additional_history_needed || ''}\n` +
                  `📌 Kết quả CLS bổ sung Bước 4: ${caseData.step4?.additional_labs_results || ''}\n\n` +
                  `=== YÊU CẦU BƯỚC 5: CHẨN ĐOÁN XÁC ĐỊNH & BIỆN LUẬN TỔNG HỢP ===\n` +
                  `1. CHẨN ĐOÁN XÁC ĐỊNH ĐẦY ĐỦ (Bệnh chính + Nguyên nhân + Biến chứng + Bệnh kèm).\n` +
                  `2. BIỆN LUẬN XÁC ĐỊNH TỔNG HỢP đầy đủ chứng cứ lâm sàng, sinh lý bệnh và cận lâm sàng.`;
        break;

      case 6:
        prompt += `📌 Chẩn đoán xác định Bước 5: ${caseData.step5?.final_dx || ''}\n\n` +
                  `=== YÊU CẦU BƯỚC 6: PHÁC ĐỒ ĐIỀU TRỊ CỤ THỂ & GIẢI THÍCH Y KHOA ===\n` +
                  `1. PHÁC ĐỒ ĐIỀU TRỊ CỤ THỂ (Hồi sức cấp cứu + Thuốc cụ thể liều/đường dùng + Theo dõi).\n` +
                  `2. GIẢI THÍCH LÝ DO & CƠ CHẾ SINH LÝ BỆNH cho từng chỉ định.`;
        break;

      default:
        return res.status(400).json({ error: 'Bước không hợp lệ.' });
    }

    const result = await callGemini(apiKey, prompt, preferredModel);
    res.json({ success: true, step: parseInt(step), response: result.text, modelUsed: result.modelUsed });

  } catch (error) {
    console.error('Backend Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Clinical WebApp đang chạy tại http://localhost:${PORT}`);
});
