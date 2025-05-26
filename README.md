# 🧪 PK Simulator Web App

A fully interactive web application for simulating pharmacokinetic (PK) profiles from custom ODE systems. Built with **Django + Bootstrap + JavaScript (Plotly)**. Designed for researchers, students, and pharmacometricians.

---

## 🔧 Features

- ✍️ **Custom ODE System** input (e.g., `dCdt = -kel*C`)
- ⚙️ Initial values & parameter definition (auto-detected from equations)
- 💉 **Flexible Dosing** interface
  - IV Bolus / Infusion
  - Repeat dosing schedule
- ⏱️ Simulation controls (time range, resolution)
- 📊 **Interactive Plot** (Plotly-based)
  - Y-axis log scale toggle
  - Auto-highlight selected compartments
- 📈 **PK Parameter Summary Table**
  - `Cmax`, `Tmax`, `AUC` per compartment
- 📂 **Observed Data Upload**
  - CSV upload of external measurements
  - Overlay as dots on simulation chart

---

## 📁 File Structure

```
simulator/
├── templates/
│   └── index.html         # Main HTML with Bootstrap UI
├── static/
│   └── simulator/js/
│       └── dosing.js      # Full simulation logic and dynamic UI
├── views.py               # Handles simulation request and returns results
├── solver.py              # Equation parser and numerical solver
```

---

## 🚀 Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/yourname/pk-simulator.git
   cd pk-simulator
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the development server:
   ```bash
   python manage.py runserver
   ```

4. Open in browser:
   ```
   http://localhost:8000/
   ```

---

## 📌 How to Use

### 1. Define ODEs
Input your differential equations using the format:
```
dCdt = -kel * C
```

### 2. Set Initial Values & Parameters
Auto-generated based on your ODEs.

### 3. Add Dosing Regimens
- Choose compartment
- Bolus or infusion
- Set amount, timing, and repeat pattern

### 4. Adjust Simulation Settings
Set time range, resolution, and compartments to plot.

### 5. Upload Observed Data *(Optional)*
Upload a `.csv` with columns:
```
Time,A1_obs,A2_obs,...
```

### 6. Run Simulation
Click 🚀 to generate plot and PK summary.

---

## 📷 Screenshots
![image](https://github.com/user-attachments/assets/453624a7-32f9-4a61-b698-95fb54822880)
![image](https://github.com/user-attachments/assets/0018bf28-18e8-49cd-ae66-5fdf01892656)


---

## 📌 TODO (Roadmap)

- Export simulation & PK summary as CSV
- Add units for parameters (e.g., mg, h, L)
- Toggleable compartments in plot
- Non-IV dosing support (oral, SC)

---

## 🧑‍💻 Author

**Minsoo Lee**  
College of Pharmacy, Seoul National University  
[Contact](mailto:minsoo.lee@snu.ac.kr)

---

## 📄 License

This project is licensed under the MIT License.
