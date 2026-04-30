document.addEventListener("DOMContentLoaded", function() {
    const text = "Electronics Technician | Junior Software Developer";
    const speed = 50; // typing speed in milliseconds
    let i = 0;
    const element = document.getElementById("typewriter");

    function typeWriter() {
        if (i < text.length) {
            element.innerHTML += text.charAt(i);
            i++;
            setTimeout(typeWriter, speed);
        } else {
            // Adds a blinking cursor at the end
            element.innerHTML += '<span class="cursor">_</span>';
            setInterval(() => {
                const cursor = document.querySelector('.cursor');
                cursor.style.opacity = cursor.style.opacity === '0' ? '1' : '0';
            }, 500);
        }
    }

    // Start typing effect slightly after load
    setTimeout(typeWriter, 500);
});
