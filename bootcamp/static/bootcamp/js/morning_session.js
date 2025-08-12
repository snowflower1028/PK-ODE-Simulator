// --- 데이터 하드코딩 ---
const EXAMPLE_NCA_DATA = {
    "Time (h)": [0.0833, 1.0, 3.0, 5.0, 12.0, 24.0, 72.0, 144.0, 216.0, 288.0, 360.0, 432.0, 504.0],
    "0.25 mg": [0.494, 0.158, 0.0248, null, null, null, null, null, null, null, null, null, null],
    "0.5 mg": [0.959, 0.392, 0.0863, 0.0248, null, null, null, null, null, null, null, null, null],
    "1.5 mg": [3.34, 1.41, 0.81, 0.669, 0.268, 0.0489, null, null, null, null, null, null, null],
    "2.5 mg": [5.01, 3.51, 2.49, 2.13, 1.87, 1.04, 0.422, null, null, null, null, null, null],
    "5 mg": [10.1, 7.41, 7.5, 7.44, 6.27, 5.14, 1.33, 0.0145, null, null, null, null, null],
    "15 mg": [26.6, 26.6, 26.1, 26.4, 25.1, 21.9, 14.1, 6.8, 0.589, 0.0168, null, null, null],
    "50 mg": [103.0, 104.0, 98.7, 91.6, 86.3, 79.2, 61.8, 47.0, 23.4, 11.1, 4.65, 0.0932, 0.0142]
};
const EXAMPLE_NCA_ANSWERS = {
    "0.25 mg": {"lambda_z": 0.4382, "t_half": 1.58, "auc_last": 2.9},
    "0.5 mg": {"lambda_z": 0.3200, "t_half": 2.17, "auc_last": 4.3},
    "1.5 mg": {"lambda_z": 0.0586, "t_half": 11.82, "auc_last": 37.1},
    "2.5 mg": {"lambda_z": 0.0104, "t_half": 66.44, "auc_last": 51.4},
    "5 mg": {"lambda_z": 0.0217, "t_half": 31.90, "auc_last": 194.6},
    "15 mg": {"lambda_z": 0.0181, "t_half": 38.28, "auc_last": 372.8},
    "50 mg": {"lambda_z": 0.0175, "t_half": 39.68, "auc_last": 788.3}
};

const FIH_DEFAULTS = {
    noael: {
        animal_bw: 3,
        human_bw: 60,
        exp: 1,
        sf: 10
    },
    mabel: {
        kd: 0.5,
        ro: 10,
        vd: 5,
        mw: 150000
    },
    pk_based: {
        cmax: 20,
        vd: 5,
        mw: 150000
    }
};


document.addEventListener('DOMContentLoaded', () => {
    initializeNcaAnalyzer();
    initializeFihTutorial();
});

function initializeNcaAnalyzer() {
    // --- NCA 분석기 ---
    const loadNcaBtn = document.getElementById('load-nca-example-btn');
    const doseSelect = document.getElementById('dose-group-select');
    const ncaPlotDiv = document.getElementById('nca-plot');
    const ncaResultsContainer = document.getElementById('nca-results-container');
    const logScaleToggle = document.getElementById('log-scale-toggle');
    const showNcaAnswerBtn = document.getElementById('show-answer-btn');

    let ncaFullData = null;
    let timeColumnName = '';
    let currentDose = '';
    let timeData = [];
    let concData = [];
    let isNcaPlotInitialized = false;

    // --- 이벤트 리스너 (NCA) ---
    loadNcaBtn.addEventListener('click', () => processNcaData(EXAMPLE_NCA_DATA));
    doseSelect.addEventListener('change', handleDoseChange);
    logScaleToggle.addEventListener('change', () => plotNcaData(true));
    showNcaAnswerBtn.addEventListener('click', displayNcaAnswers);

    // --- NCA 함수들 ---
    function processNcaData(data) {
        ncaFullData = data;
        timeColumnName = Object.keys(data)[0];
        const doses = Object.keys(data).filter(k => k !== timeColumnName);
        doseSelect.innerHTML = doses.map(d => `<option value="${d}">${d}</option>`).join('');
        doseSelect.disabled = false;
        showNcaAnswerBtn.disabled = false;
        handleDoseChange();
    }

    function handleDoseChange() {
        currentDose = doseSelect.value;
        if (!currentDose || !ncaFullData) return;
        timeData = [];
        concData = [];
        ncaFullData[timeColumnName].forEach((t, i) => {
            const c = ncaFullData[currentDose][i];
            if (t !== null && !isNaN(t) && c !== null && !isNaN(c)) {
                timeData.push(t);
                concData.push(c);
            }
        });
        plotNcaData(true);
    }
    
    function plotNcaData(resetSelection) {
        document.getElementById('nca-plot-placeholder').style.display = 'none';
        ncaPlotDiv.style.display = 'block';
        const trace = { x: timeData, y: concData, mode: 'lines+markers', type: 'scatter' };
        const layout = { xaxis: { title: timeColumnName }, yaxis: { title: 'Concentration (nM)', type: logScaleToggle.checked ? 'log' : 'linear', autorange: true }, dragmode: 'select', margin: { l: 50, r: 20, t: 20, b: 40 } };
        Plotly.react(ncaPlotDiv, [trace], layout);
        if (!isNcaPlotInitialized) {
            ncaPlotDiv.on('plotly_selected', (eventData) => calculateNCA(eventData));
            ncaPlotDiv.on('plotly_deselect', clearResults);
            isNcaPlotInitialized = true;
        }
        if (resetSelection) clearResults();
    }
    
    function calculateNCA(eventData) {
        const points = eventData?.points;
        if (!points || points.length < 2) {
            clearResults();
            return;
        }
        try {
            const selectedPoints = points.map(p => ({ time: p.x, logConc: Math.log(p.y) }));
            const n = selectedPoints.length;
            const sumX = selectedPoints.reduce((acc, p) => acc + p.time, 0);
            const sumY = selectedPoints.reduce((acc, p) => acc + p.logConc, 0);
            const sumXY = selectedPoints.reduce((acc, p) => acc + p.time * p.logConc, 0);
            const sumX2 = selectedPoints.reduce((acc, p) => acc + p.time * p.time, 0);
            const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
            const lambda_z = -slope;
            const t_half = lambda_z > 0 ? Math.LN2 / lambda_z : Infinity;
            let auc_last = 0;
            for (let i = 0; i < timeData.length - 1; i++) {
                auc_last += (concData[i] + concData[i+1]) / 2 * (timeData[i+1] - timeData[i]);
            }
            const cmax = Math.max(...concData);
            const tmax = timeData[concData.indexOf(cmax)];
            ncaResultsContainer.innerHTML = `
                <h6 class="subsection-title mt-0 pt-0 border-0">주요 PK 파라미터</h6>
                <dl class="result-grid">
                  <dt>Cmax</dt><dd>${cmax.toFixed(2)} nM</dd>
                  <dt>Tmax</dt><dd>${tmax.toFixed(2)} hr</dd>
                  <dt><strong>AUC_last</strong></dt><dd><strong>${auc_last.toFixed(2)} nM*hr</strong></dd>
                </dl>
                <hr>
                <h6 class="subsection-title">Terminal Phase 분석 <span class="text-muted small">(${n}개 점 선택됨)</span></h6>
                <div class="result-formula"><p class="small text-muted mb-1">$ \\lambda_z = - (\\text{ln-linear 기울기}) $</p><dl class="result-grid mb-0"><dt>Lambda_z ($ \\lambda_z $)</dt><dd>${lambda_z.toFixed(4)} hr⁻¹</dd></dl></div>
                <div class="result-formula mt-2"><p class="small text-muted mb-1">$ t_{1/2} = \\frac{\\ln(2)}{\\lambda_z} $</p><dl class="result-grid mb-0"><dt>Half-life ($ t_{1/2} $)</dt><dd>${t_half.toFixed(2)} hr</dd></dl></div>
                <hr>
                <h6 class="subsection-title">상세 AUC 계산 과정</h6>
                <div class="table-responsive" style="max-height: 250px;"><table class="table table-sm table-striped"><thead class="table-light"><tr><th>Time Interval (h)</th><th>부분 AUC</th><th>누적 AUC</th></tr></thead><tbody>${
                    (() => {
                        let partialAucHtml = '';
                        let cumulativeAuc = 0;
                        for (let i = 0; i < timeData.length - 1; i++) {
                            const partialAuc = (concData[i] + concData[i+1]) / 2 * (timeData[i+1] - timeData[i]);
                            cumulativeAuc += partialAuc;
                            partialAucHtml += `<tr><td>${timeData[i].toFixed(2)} - ${timeData[i+1].toFixed(2)}</td><td>${partialAuc.toFixed(2)}</td><td>${cumulativeAuc.toFixed(2)}</td></tr>`;
                        }
                        return partialAucHtml;
                    })()
                }</tbody></table></div>`;
            MathJax.typesetPromise([ncaResultsContainer]);
        } catch (error) {
            console.error("Error during NCA calculation:", error);
            ncaResultsContainer.innerHTML = `<div class="alert alert-danger small"><strong>Calculation Error:</strong> ${error.message}</div>`;
        }
    }

    function displayNcaAnswers() {
        const answerData = EXAMPLE_NCA_ANSWERS[currentDose];
        if (!answerData) { alert('현재 용량 그룹에 대한 정답 데이터가 없습니다.'); return; }
        const answerHtml = `<div class="alert alert-info mt-3"><h6 class="alert-heading">정답</h6><ul class="list-unstyled mb-0 small"><li><strong>Lambda_z:</strong> ${answerData.lambda_z.toFixed(4)} hr⁻¹</li><li><strong>Half-life:</strong> ${answerData.t_half.toFixed(2)} hr</li><li><strong>AUC_last:</strong> ${answerData.auc_last.toFixed(1)} nM*hr</li></ul></div>`;
        const existingAnswer = ncaResultsContainer.querySelector('.alert-info');
        if (existingAnswer) existingAnswer.remove();
        ncaResultsContainer.insertAdjacentHTML('beforeend', answerHtml);
    }

    function clearResults() {
        ncaResultsContainer.innerHTML = `<div class="placeholder-text">그래프에서 Terminal Phase를 선택하여 PK 파라미터를 계산하세요.</div>`;
        if (isNcaPlotInitialized) {
            Plotly.restyle(ncaPlotDiv, {selectedpoints: [null]});
        }
    }
}

/**
 * FIH 튜토리얼 관련 모든 기능을 초기화합니다.
 */
function initializeFihTutorial() {
    // --- 공통 DOM 요소 ---
    const loadFihBtn = document.getElementById('load-fih-defaults-btn');

    // --- NOAEL 관련 DOM 요소 및 이벤트 ---
    const noaelStartBtn = document.getElementById('noael-start-btn');
    const noaelStep2 = document.getElementById('noael-step-2');
    const noaelStep34 = document.getElementById('noael-step-3-4');
    const noaelButtons = noaelStep2.querySelectorAll('button');
    const noaelFeedback = document.getElementById('noael-feedback');
    const noaelFinalResult = document.getElementById('noael-final-result');
    const noaelInputs = {
        noael: document.getElementById('noael-input-noael'),
        bwAnimal: document.getElementById('noael-input-bw-animal'),
        bwHuman: document.getElementById('noael-input-bw-human'),
        exp: document.getElementById('noael-input-exp'),
        sf: document.getElementById('noael-input-sf')
    };

    // --- MABEL 관련 DOM 요소 및 이벤트 ---
    const mabelStartBtn = document.getElementById('mabel-start-btn');
    const mabelFinalResult = document.getElementById('mabel-final-result');
    const mabelInputs = {
        kd: document.getElementById('mabel-input-kd'),
        ro: document.getElementById('mabel-input-ro'),
        vd: document.getElementById('mabel-input-vd'),
        mw: document.getElementById('mabel-input-mw')
    };
    
    // --- PK-based 관련 DOM 요소 및 이벤트 ---
    // (구조가 유사하므로 필요시 추가)

    // --- 공통 이벤트 ---
    loadFihBtn.addEventListener('click', loadFihDefaults);

    // --- NOAEL 튜토리얼 로직 ---
    noaelStartBtn.addEventListener('click', function() {
        // ✨ [수정] 버튼의 부모 div를 숨겨서 버튼만 사라지게 함
        this.parentElement.style.display = 'none';
        noaelStep2.classList.remove('d-none');
    });

    noaelButtons.forEach(button => {
        button.addEventListener('click', () => {
            const selectedNoael = button.dataset.noael;
            const selectedSpecies = button.dataset.species;
            noaelButtons.forEach(btn => btn.classList.remove('active', 'list-group-item-danger', 'list-group-item-success'));

            if (selectedSpecies === 'Monkey') {
                button.classList.add('active', 'list-group-item-success');
                noaelFeedback.innerHTML = `<div class="alert alert-success small p-2"><strong>정답입니다!</strong> 사람과 가장 계통학적으로 유사한 영장류(Monkey)의 데이터를 사용하는 것이 가장 보수적이고 적절합니다.</div>`;
                noaelInputs.noael.value = selectedNoael;
                noaelStep34.classList.remove('d-none');
                updateNoaelDose();
            } else {
                button.classList.add('list-group-item-danger');
                noaelFeedback.innerHTML = `<div class="alert alert-warning small p-2"><strong>다시 생각해보세요.</strong> 일반적으로 사람과 가장 유사한 동물 종의 데이터를 사용하거나, 여러 종 중 가장 낮은 값(가장 보수적인 값)을 선택합니다.</div>`;
                noaelStep34.classList.add('d-none');
                noaelFinalResult.innerHTML = '';
            }
        });
    });

    Object.values(noaelInputs).forEach(input => input.addEventListener('input', updateNoaelDose));

    function updateNoaelDose() {
        const noael = parseFloat(noaelInputs.noael.value);
        const bwAnimal = parseFloat(noaelInputs.bwAnimal.value);
        const bwHuman = parseFloat(noaelInputs.bwHuman.value);
        const exp = parseFloat(noaelInputs.exp.value);
        const sf = parseFloat(noaelInputs.sf.value);

        if ([noael, bwAnimal, bwHuman, exp, sf].some(isNaN)) {
            noaelFinalResult.innerHTML = ''; return;
        }

        const hed = noael * Math.pow((bwAnimal / bwHuman), 1 - exp);
        const fihDose = hed / sf;

        noaelFinalResult.innerHTML = `
            <div class="result-formula"><p class="small text-muted mb-1">계산된 HED: $ ${noael.toFixed(2)} \\times (\\frac{${bwAnimal}}{${bwHuman}})^{1-${exp}} = \\mathbf{${hed.toFixed(2)}} \\text{ mg/kg} $</p></div>
            <div class="alert alert-success mt-3"><strong>계산된 FIH Starting Dose: <br> $ \\frac{${hed.toFixed(2)} \\text{ mg/kg}}{${sf}} = \\mathbf{${fihDose.toFixed(2)}} \\text{ mg/kg} $</strong></div>`;
        MathJax.typesetPromise([noaelFinalResult]);
    }


    // --- MABEL 튜토리얼 로직 ---
    mabelStartBtn.addEventListener('click', function() {
        updateMabelDose();
    });

    Object.values(mabelInputs).forEach(input => input.addEventListener('input', updateMabelDose));
    
    function updateMabelDose() {
        const kd = parseFloat(mabelInputs.kd.value);
        const ro = parseFloat(mabelInputs.ro.value) / 100; // % to fraction
        const vd = parseFloat(mabelInputs.vd.value);
        const mw = parseFloat(mabelInputs.mw.value);
        
        if ([kd, ro, vd, mw].some(isNaN)) {
            mabelFinalResult.innerHTML = '<div class="placeholder-text small">입력값을 넣고 계산 버튼을 누르세요.</div>'; return;
        }

        const targetConc = kd * (ro / (1 - ro));
        const doseNmol = targetConc * vd;
        const doseMg = doseNmol * mw / 1e6;
        
        mabelFinalResult.innerHTML = `
            <div class="result-formula"><p class="small text-muted mb-1">1. Target Conc. 계산</p><p class="small">수식: $ C_{target} = K_D \\times \\frac{RO}{1-RO} $</p><p class="small">계산: $ ${targetConc.toFixed(3)} \\text{ nM} = ${kd} \\text{ nM} \\times \\frac{${ro.toFixed(2)}}{1-${ro.toFixed(2)}} $</p></div>
            <hr class="my-2">
            <div class="result-formula"><p class="small text-muted mb-1">2. Dose (mg) 계산</p><p class="small">수식: $ \\text{Dose(mg)} = C_{target} \\times V_d \\times MW \\times 10^{-6} $</p><p class="small">계산: $ ${doseMg.toFixed(3)} \\text{ mg} = ${targetConc.toFixed(3)} \\text{ nmol/L} \\times ${vd} \\text{ L} \\times ${mw} \\text{ g/mol} \\times 10^{-6} $</p></div>
            <div class="alert alert-success mt-3"><strong>계산된 FIH Starting Dose: ${doseMg.toFixed(3)} mg</strong></div>`;
        MathJax.typesetPromise([mabelFinalResult]);
    }

    // --- PK-based 튜토리얼 로직 (추가) ---
    // ...

    // --- 공통 함수 ---
    function loadFihDefaults() {
        // NOAEL
        noaelInputs.bwAnimal.value = FIH_DEFAULTS.noael.animal_bw;
        noaelInputs.bwHuman.value = FIH_DEFAULTS.noael.human_bw;
        noaelInputs.exp.value = FIH_DEFAULTS.noael.exp;
        noaelInputs.sf.value = FIH_DEFAULTS.noael.sf;
        
        // MABEL
        mabelInputs.kd.value = FIH_DEFAULTS.mabel.kd;
        mabelInputs.ro.value = FIH_DEFAULTS.mabel.ro;
        mabelInputs.vd.value = FIH_DEFAULTS.mabel.vd;
        mabelInputs.mw.value = FIH_DEFAULTS.mabel.mw;
        
        // PK-based
        // ...
        
        // 로드 후 각 계산 함수 호출하여 결과 즉시 표시
        if (noaelInputs.noael.value) {
            updateNoaelDose();
        }
        updateMabelDose();
        
        alert('FIH 예제 데이터 로드 완료!');
    }
}
