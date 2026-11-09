import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import "../styles.css";
import "./pet.css";

createRoot(document.getElementById("pet-root")!).render(
  <StrictMode>
    <PetApp />
  </StrictMode>,
);
