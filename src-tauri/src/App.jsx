import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const appWindow = getCurrentWindow();

function App() {
  const [tab, setTab] = useState("cases");    // cases | calendar
  const [opacity, setOpacity] = useState(1);  // 배경 불투명도 (0.2~1)
  const [showHeader, setShowHeader] = useState(true);

  const bg = `rgba(28, 28, 30, ${opacity})`;

  const minimize = async () => { try { await appWindow.minimize(); } catch (e) {} };
  const close = async () => { try { await appWindow.close(); } catch (e) {} };

  return (
    <div className="widget" style={{ background: bg }}>
      {showHeader ? (
        <div className="widget-header" data-tauri-drag-region>
          <div className="tabs">
            <button
              className={tab === "cases" ? "tab active" : "tab"}
              onClick={() => setTab("cases")}
            >
              내 사건
            </button>
            <button
              className={tab === "calendar" ? "tab active" : "tab"}
              onClick={() => setTab("calendar")}
            >
              캘린더
            </button>
          </div>

          <div className="header-right">
            <input
              className="opacity-slider"
              type="range"
              min="0.2"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              title="배경 투명도"
            />
            <button className="win-btn" onClick={() => setShowHeader(false)} title="헤더 숨기기">▴</button>
            <button className="win-btn" onClick={minimize} title="최소화">﹣</button>
            <button className="win-btn close" onClick={close} title="닫기">✕</button>
          </div>
        </div>
      ) : (
        <div className="widget-handle" data-tauri-drag-region>
          <button className="win-btn" onClick={() => setShowHeader(true)} title="헤더 보이기">▾</button>
        </div>
      )}

      <div className="widget-body">
        {tab === "cases" && (
          <p className="placeholder">
            여기에 곧 로그인과 내 진행 사건이 표시됩니다.
          </p>
        )}
        {tab === "calendar" && (
          <p className="placeholder">
            여기에 곧 월간 캘린더가 표시됩니다.
          </p>
        )}
      </div>
    </div>
  );
}

export default App;
