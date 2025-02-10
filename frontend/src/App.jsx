import { useState } from "react";
import { Button } from "@/components/ui/button";

import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div className="text-blue-400 text-3xl">Hello World</div>
      <Button>Click Me</Button>
    </>
  );
}

export default App;
