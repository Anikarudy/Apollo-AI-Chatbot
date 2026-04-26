import React from "react";
import ChatWidget from "./components/ChatWidget";

// Standalone page — the Apollo website team embeds this URL in an <iframe>.
// The widget fills 100% of the iframe with no extra chrome.

const App: React.FC = () => {
  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <ChatWidget />
    </div>
  );
};

export default App;
