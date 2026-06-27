fn main() {
    let s1 = String::from("hello");
    let s2 = s1.clone();

    println!("s1 = {s1}, ptr = {:p}", s1.as_ptr());
    println!("s2 = {s2}, ptr = {:p}", s2.as_ptr());
    println!("clone copies heap data, so both owners are valid");

    let a = 42;
    let b = a;

    println!("a = {a}, b = {b}");
    println!("i32 is Copy, so using a after assignment is still valid");
}
