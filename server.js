const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Prompt hệ thống Bác sĩ Nội khoa 20 năm kinh nghiệm
const SYSTEM_PROMPT_HEADER = `
Bạn là một BÁC SĨ NỘI KHOA CAO CẤP CÓ 20 NĂM KINH NGHIỆM LÂM SÀNG TẠI CÁC BỆNH VIỆN TUYẾN TỈNH VÀ TƯƠNG ĐƯƠNG.
Tư duy lâm sàng kết hợp giữa:
1. Thuyết xử lý kép (Dual-Process) & Kịch bản bệnh lý (Illness Scripts).
2. Khung phân loại VINDICATED & Mã hóa ICD-10 chuẩn Bộ Y tế Việt Nam.
3. Siêu âm tại giường POCUS / BLUE Protocol & Phác đồ Bộ Y tế / Guidelines quốc tế (ESC, AHA, GINA, GOLD, KDIGO).

Yêu cầu phản hồi:
- Sử dụng ngôn ngữ y khoa chính xác, chuyên nghiệp, lập luận chặt chẽ.
- Trình bày dạng Markdown với tiêu đề, bảng biểu và bullet points trực quan.
`;

// Hàm gọi Gemini API hỗ trợ chuyển đổi mô hình dự phòng
async function callGemini(apiKey, promptText, imageBase64List = [], preferredModel = 'gemini-3.5-flash-lite') {
  const cleanKey = apiKey ? apiKey.trim() : process.env.GEMINI_API_KEY;
  if (!cleanKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong .env hoặc giao diện.');
  }

  const modelsToTry = [preferredModel, 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.8-live'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  for (const model of uniqueModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
    
    // Xây dựng parts cho Multimodal
    const parts = [{ text: promptText }];
    if (Array.isArray(imageBase64List) && imageBase64List.length > 0) {
      for (const imgBase64 of imageBase64List) {
        if (imgBase64 && imgBase64.includes('base64,')) {
          const mimeType = imgBase64.split(';')[0].split(':')[1] || 'image/jpeg';
          const data = imgBase64.split('base64,')[1];
          parts.push({
            inlineData: { mimeType, data }
          });
        }
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 3072 }
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

// Endpoint xử lý phân tích các phần lâm sàng
app.post('/api/analyze', async (req, res) => {
  try {
    const { section, caseData, customPrompt, imageList, customApiKey, preferredModel } = req.body;
    const apiKey = customApiKey || process.env.GEMINI_API_KEY;

    if (!section || !caseData) {
      return res.status(400).json({ error: 'Thiếu tham số "section" hoặc "caseData".' });
    }

    let prompt = `${SYSTEM_PROMPT_HEADER}\n\n=== HỒ SƠ CASE LÂM SÀNG BỆNH NHÂN ===\n`;
    prompt += `📌 Tên bệnh nhân: ${caseData.part1?.patient_name || 'N/A'}\n`;
    prompt += `📌 Giới tính: ${caseData.part1?.gender || 'N/A'} | Tuổi / Năm sinh: ${caseData.part1?.age || 'N/A'}\n`;
    prompt += `📌 Ngày nhập viện: ${caseData.part1?.admission_date || 'N/A'}\n`;
    prompt += `📌 Lý do vào viện: ${caseData.part1?.chief_complaint || 'N/A'}\n`;
    prompt += `📌 Sinh hiệu ban đầu: ${caseData.part1?.vitals || 'N/A'}\n`;
    prompt += `📌 Triệu chứng cơ năng & Bệnh sử: ${caseData.part1?.history || 'N/A'}\n`;
    prompt += `📌 Tiền căn: ${caseData.part1?.pmh || 'N/A'}\n`;
    prompt += `📌 Khám lâm sàng: ${caseData.part1?.physical_exam || 'N/A'}\n`;
    prompt += `📌 Kết quả Cận lâm sàng ban đầu: ${caseData.part1?.current_labs || 'N/A'}\n\n`;

    if (caseData.part2?.analysis) {
      prompt += `=== PHẦN 2: VẤN ĐỀ & CHẨN ĐOÁN SƠ BỘ ===\n${caseData.part2.analysis}\n\n`;
    }
    if (caseData.part3?.analysis) {
      prompt += `=== PHẦN 3: CHẨN ĐOÁN HIỆN TẠI & CLS BỔ SUNG ===\n${caseData.part3.analysis}\n\n`;
    }
    if (caseData.part4?.progress_list && caseData.part4.progress_list.length > 0) {
      prompt += `=== PHẦN 4: LỊCH SỬ DIỄN TIẾN BỆNH QUA CÁC NGÀY ===\n`;
      caseData.part4.progress_list.forEach((p, idx) => {
        prompt += `--- Ngày ${p.date || idx + 1} ---\n`;
        prompt += `Diễn tiến & Y lệnh: ${p.text || 'N/A'}\n`;
        prompt += `Kết quả CLS mới: ${p.labs_text || 'N/A'}\n`;
        if (p.analysis) prompt += `Đánh giá AI: ${p.analysis}\n`;
      });
      prompt += `\n`;
    }

    if (customPrompt) {
      prompt += `⚠️ YÊU CẦU PHÂN TÍCH CỤ THỂ TỪ BÁC SĨ: "${customPrompt}"\n\n`;
    }

    switch (parseInt(section)) {
      case 1: // Auto-parse raw medical note into structured fields
        prompt += `=== YÊU CẦU PHẦN 1: BÓC TÁCH VĂN BẢN BỆNH ÁN THÔ ===\n` +
                  `Dựa trên đoạn văn bản bệnh án thô sau: "${caseData.part1?.raw_text || ''}"\n` +
                  `Hãy phân loại và trả về dạng JSON duy nhất chứa 5 trường:\n` +
                  `{\n` +
                  `  "vitals": "Mạch, Huyết áp, Nhịp thở, SpO2, Nhiệt độ",\n` +
                  `  "history": "Bệnh sử & Triệu chứng cơ năng",\n` +
                  `  "pmh": "Tiền căn bản thân & gia đình",\n` +
                  `  "physical_exam": "Khám lâm sàng các cơ quan",\n` +
                  `  "current_labs": "Kết quả xét nghiệm & Cận lâm sàng ban đầu"\n` +
                  `}\n` +
                  `Chỉ trả về chuỗi JSON hợp lệ, không kèm văn bản giải thích.`;
        break;

      case 2: // Vấn đề - Chẩn đoán sơ bộ
        prompt += `=== YÊU CẦU PHẦN 2: TỰ ĐỘNG PHÂN TÍCH VẤN ĐỀ & CHẨN ĐOÁN SƠ BỘ ===\n` +
                  `1. Tóm tắt danh sách vấn đề (Problem List) gom nhóm theo mức độ nặng từ nguy kịch/nặng đến nhẹ.\n` +
                  `2. Đưa ra CHẨN ĐOÁN SƠ BỘ phù hợp. ĐẶC BIỆT: GẮN MÃ ICD-10 CHUẨN BỘ Y TẾ VIỆT NAM VÀO TRƯỚC MỖI CHẨN ĐOÁN (Ví dụ: [I50.1] Phù phổi cấp do tim...).\n` +
                  `3. Biện luận lâm sàng cụ thể theo từng bước (Illness Scripts & VINDICATED).\n` +
                  `4. Đề xuất các Cận lâm sàng cần thiết tiếp theo để làm rõ.`;
        break;

      case 3: // Chẩn đoán hiện tại
        prompt += `=== YÊU CẦU PHẦN 3: CHẨN ĐOÁN HIỆN TẠI DỰA TRÊN CLS BỔ SUNG ===\n` +
                  `📌 Kết quả CLS bổ sung vừa nhập: ${caseData.part3?.additional_labs || 'Không có'}\n` +
                  `Sử dụng các tài liệu chuyên sâu về phân tích cận lâm sàng (Lab values, ECG, POCUS, X-quang...):\n` +
                  `1. Đưa ra CHẨN ĐOÁN HIỆN TẠI gắn mã ICD-10 Bộ Y tế phía trước.\n` +
                  `2. Biện luận đối chiếu kết quả CLS mới với tình trạng ban đầu.\n` +
                  `3. Đánh giá các biến chứng/vấn đề cần tiếp tục theo dõi sát.`;
        break;

      case 4: // Diễn tiến bệnh & Tóm tắt cận lâm sàng
        prompt += `=== YÊU CẦU PHẦN 4: PHÂN TÍCH DIỄN TIẾN BỆNH & TÓM TẮT CẬN LÂM SÀNG ===\n` +
                  `📌 Thông tin diễn tiến & y lệnh mới nhất: ${req.body.current_progress_text || 'N/A'}\n` +
                  `📌 Kết quả CLS mới nhất: ${req.body.current_progress_labs || 'N/A'}\n` +
                  `Hãy thực hiện:\n` +
                  `1. Phân tích diễn tiến & đối chiếu với toàn bộ lịch sử các ngày trước đó (Tốt lên / Xấu đi).\n` +
                  `2. Đưa ra y lệnh và đề xuất cận lâm sàng tiếp theo.\n` +
                  `3. Tự động kiểm tra Chẩn đoán theo mã ICD-10, tự đề xuất thêm các mã ICD-10 cần thiết dựa theo diễn tiến lâm sàng.\n` +
                  `4. TÓM TẮT DIỄN TIẾN CẬN LÂM SÀNG DẠNG MŨI TÊN (Lab Trend Summary) đúng định dạng:\n` +
                  `   - WBC 2.8 -> 4.0 K/uL\n` +
                  `   - Pro-Calcitonin máu: 0.4 (28/09) -> 0.7 (30/09) ng/mL\n` +
                  `   - X-Quang ngực thẳng: THÂM NHIỄM 2 PHẾ TRƯỜNG (28/09) -> THÂM NHIỄM 2 PHẾ TRƯỜNG, XUẤT HIỆN TỔN THƯƠNG MỚI (30/09) (Các kết quả hình ảnh học phải ghi ngày cạnh bên).`;
        break;

      case 5: // Phác đồ và kế hoạch điều trị (Next 3 Days)
        prompt += `=== YÊU CẦU PHẦN 5: PHÁC ĐỒ VÀ KẾ HOẠCH ĐIỀU TRỊ 3 NGÀY TIẾP THEO ===\n` +
                  `Dựa trên toàn bộ thông tin từ Phần 1 đến Phần 4:\n` +
                  `1. Đưa ra PHÁC ĐỒ ĐIỀU TRỊ CHUYÊN SÂU (Thuốc, liều dùng, đường dùng, hồi sức cấp cứu).\n` +
                  `2. LẬP KẾ HOẠCH ĐIỀU TRỊ CHI TIẾT CHO 3 NGÀY TIẾP THEO (Ngày +1, Ngày +2, Ngày +3):\n` +
                  `   - Các chỉ định điều trị/chăm sóc cụ thể từng ngày.\n` +
                  `   - Danh mục xét nghiệm / Cận lâm sàng bắt buộc cần làm cho TỪNG NGÀY cụ thể.\n` +
                  `3. Nếu đã có thông tin trước đó, giữ nguyên và cập nhật bổ sung thêm mà không làm xáo trộn dữ liệu cũ.`;
        break;

      case 6: // Y lệnh, Y lệnh dự trù ngày +1, Kháng sinh & TỔNG KẾT XUẤT VIỆN
        prompt += `=== YÊU CẦU PHẦN 6: Y LỆNH, Y LỆNH DỰ TRÙ VÀ TỔNG KẾT XUẤT VIỆN ===\n` +
                  `1. Tự động tổng hợp Y lệnh ngày hôm nay & Y lệnh dự trù cho Ngày tiếp theo (${req.body.next_date || 'ngày mai'}).\n` +
                  `2. Tự động nhắc nhở thuốc/chăm sóc/dinh dưỡng/thở oxy từ Phần 4.\n` +
                  `3. Tự động cộng ngày dùng thuốc đối với các kháng sinh (VD: Meropenem ngày 3/7, Vancomycin ngày 2/10...).\n` +
                  `4. ĐẶC BIỆT - TỔNG KẾT XUẤT VIỆN (Nếu có dự kiến/quyết định xuất viện hoặc kết thúc đợt điều trị):\n` +
                  `   Hãy tạo BẢNG TỔNG KẾT XUẤT VIỆN chuẩn theo đúng mẫu sau:\n` +
                  `   TỔNG KẾT XUẤT VIỆN\n` +
                  `   - Bệnh nhân: ${caseData.part1?.patient_name || 'N/A'}, Giới tính: ${caseData.part1?.gender || 'N/A'}, Tuổi: ${caseData.part1?.age || 'N/A'}\n` +
                  `   - Ngày nhập viện: ${caseData.part1?.admission_date || 'N/A'}\n` +
                  `   - Ngày xuất viện: ${req.body.discharge_date || 'Dự kiến +1 ngày'}\n` +
                  `   - (Chẩn đoán): [Lấy chẩn đoán thuộc phần 4 có mã ICD-10]\n` +
                  `   - Điều trị: [Tóm tắt ngắn gọn toàn bộ phác đồ đã điều trị: Kháng sinh, Oxy liệu pháp, điều chỉnh đường huyết - huyết áp, chạy thận, phẫu thuật/thủ thuật...]`;
        break;

      default:
        return res.status(400).json({ error: 'Mục không hợp lệ.' });
    }

    const result = await callGemini(apiKey, prompt, imageList || [], preferredModel);
    res.json({ success: true, section: parseInt(section), response: result.text, modelUsed: result.modelUsed });

  } catch (error) {
    console.error('Backend Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Clinical WebApp v6.0 đang chạy tại http://localhost:${PORT}`);
});
